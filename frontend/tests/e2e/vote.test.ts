/**
 * The app in a real browser.
 *
 * A Brave instance loads the built static files off a local server, exactly
 * as GitHub Pages would serve them, and talks to the live database. The
 * fixture ballot is built through the API before the browser starts and torn
 * down afterwards, so a run leaves nothing behind.
 *
 * Run `bun run build` first. HEADED=1 watches it happen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId: string;
let motionId: string;
let chairId: string;
let pins: string[];

const consoleErrors: string[] = [];

async function newPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });   // a phone at the back of the hall
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  return page;
}

beforeAll(async () => {
  if (!(await Bun.file(`${DIST}/index.html`).exists())) {
    throw new Error('No dist/. Run `bun run build` before the browser tests.');
  }

  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);

  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).maybeSingle();

  const orgId = org?.id ?? (await organizer.from('organizations')
    .insert({ owner_id: user.user!.id, slug: uniqueSlug('e2e-org'), name: 'E2E Org' })
    .select('id').single()).data!.id;

  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: orgId, slug: uniqueSlug('e2e'), title: 'Browser Run',
    description: 'Driven by Brave.', status: 'live', mode: 'gated',
    allow_vote_change: true, results_public: true, show_results_after: true,
  }).select('id').single();
  ballotId = ballot!.id;

  const { data: motion } = await organizer.from('questions_yes_no').insert({
    ballot_id: ballotId, prompt: 'Adopt the minutes', sort_order: 1,
  }).select('id').single();
  motionId = motion!.id;

  const { data: chair } = await organizer.from('questions_highest_outright').insert({
    ballot_id: ballotId, prompt: 'Elect the chair', sort_order: 2,
  }).select('id').single();
  chairId = chair!.id;

  await organizer.from('options_highest_outright').insert(
    ['Ann Meyer', 'Ben Naidoo'].map((label, i) => ({ question_id: chairId, label, sort_order: i })),
  );

  const { data: issued } = await organizer.rpc('issue_tokens', {
    p_ballot: ballotId, p_count: 2, p_label_prefix: 'Seat',
  });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  browser = await launchBrave();
});

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

/* ------------------------------------------------------------------------ */

describe('the voter', () => {
  test('is turned away by a PIN that is not on the ballot', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Browser Run');

    await page.type('.pin-entry', '000000');
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'not valid');
    await page.close();
  });

  test('sees the waiting screen while every gate is closed', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await page.type('.pin-entry', pins[0]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'No question is open yet');
    expect(await page.$$eval('.lobby-item', (n) => n.length)).toBe(0);
    await page.close();
  });

  test('votes on the motion the chair opens, and cannot vote twice on it', async () => {
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });

    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await page.type('.pin-entry', pins[0]!);
    await clickByText(page, 'button', 'Open my ballot');

    await waitForText(page, 'Adopt the minutes');
    await clickByText(page, '.lobby-item', 'Adopt the minutes');
    await waitForText(page, 'Yes');
    await clickByText(page, '.choice', 'Yes');

    // show_results_after is on, so the receipt carries the count.
    await waitForText(page, 'Thank you');
    await waitForText(page, 'Carried');

    await clickByText(page, 'button', 'Back to the ballot');
    await waitForText(page, 'Change');       // allow_vote_change is on

    await organizer.from('ballots').update({ allow_vote_change: false }).eq('id', ballotId);
    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'Voted');
    const settled = await page.$$eval('.lobby-item', (nodes) =>
      nodes.map((n) => (n as HTMLButtonElement).disabled));
    expect(settled).toContain(true);

    await organizer.from('ballots').update({ allow_vote_change: true }).eq('id', ballotId);
    await page.close();
  });

  test('follows the meeting when the chair moves to the next question', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await page.type('.pin-entry', pins[1]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'Adopt the minutes');

    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'highest_outright', p_question: chairId, p_open: true, p_only: true,
    });

    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'Elect the chair');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('Adopt the minutes');

    await clickByText(page, '.lobby-item', 'Elect the chair');
    await waitForText(page, 'Ann Meyer');
    await clickByText(page, '.choice', 'Ann Meyer');
    await clickByText(page, 'button', 'Submit my vote');
    await waitForText(page, 'Thank you');
    await page.close();
  });

  test('sees a vote against a gate the chair has since closed refused', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await page.type('.pin-entry', pins[0]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'Elect the chair');
    await clickByText(page, '.lobby-item', 'Elect the chair');
    await waitForText(page, 'Ann Meyer');

    // The chair closes it while this voter is still looking at the page.
    await organizer.rpc('close_all_gates', { p_ballot: ballotId });

    await clickByText(page, '.choice', 'Ben Naidoo');
    await clickByText(page, 'button', 'Submit my vote');
    await waitForText(page, 'not open');
    await page.close();
  });
});

describe('the results page', () => {
  test('publishes the count to a reader with no PIN', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Browser Run');
    await waitForText(page, 'Adopt the minutes');
    await waitForText(page, 'Elect the chair');
    await waitForText(page, 'Ann Meyer');
    await page.close();
  });
});

describe('the organizer', () => {
  test('signs in and reaches their ballots', async () => {
    const { email, password } = credentials();
    const page = await newPage();
    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });

    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    await clickByText(page, 'button', 'Sign in');

    await waitForText(page, 'Your ballots');
    await waitForText(page, 'Browser Run');
    await page.close();
  });

  test('opens and closes a gate from the Live tab', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Adopt the minutes');

    await clickByText(page, 'button', 'Open only this');
    // 'Open' alone matches the button that was just pressed; `.pill.open` is a
    // gate and nothing else -- the ballot's own status pill is `.pill.live`.
    await page.waitForSelector('.pill.open', { timeout: 15000 });

    const voter = anonClient();
    const { data } = await voter.rpc('voter_state', {
      p_ballot: ballotId, p_pin: pins[0]!, p_fingerprint: 'e2e',
    });
    expect((data as { questions: unknown[] }).questions).toHaveLength(1);

    await clickByText(page, 'button', 'Close all gates');
    await page.close();
  });
});

describe('the browser console', () => {
  test('stayed quiet through all of it', () => {
    const noise = consoleErrors.filter((line) => !/favicon|Failed to load resource/i.test(line));
    expect(noise).toEqual([]);
  });
});
