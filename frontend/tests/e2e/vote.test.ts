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
import { clickByText, clickWithin, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

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
    p_ballot: ballotId, p_count: 2,
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

    await enterPin(page, '000000');
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'not valid');
    await page.close();
  });

  test('sees the waiting screen while every gate is closed', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(page, pins[0]!);
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
    await enterPin(page, pins[0]!);
    await clickByText(page, 'button', 'Open my ballot');

    await waitForText(page, 'Adopt the minutes');
    // Answered in place -- no tapping into a question and backing out again.
    await clickWithin(page, '.card', 'Adopt the minutes', '.choice', 'Yes');
    await clickWithin(page, '.card', 'Adopt the minutes', 'button', 'Submit my vote');

    // Recorded in place; no count yet, because the gate is still open.
    await waitForText(page, 'Your answer is recorded');
    const board = await page.evaluate(() => document.body.innerText);
    expect(board).not.toContain('Carried');

    // The chair closes it, and the count appears further down the same page.
    await organizer.rpc('close_all_gates', { p_ballot: ballotId });
    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'Carried');

    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'Answered');

    await organizer.from('ballots').update({ allow_vote_change: false }).eq('id', ballotId);
    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'You have already voted on this question');
    const stillOffered = await page.$$eval('button',
      (nodes) => nodes.some((n) => n.innerText.trim() === 'Submit my vote'));
    expect(stillOffered).toBe(false);

    await organizer.from('ballots').update({ allow_vote_change: true }).eq('id', ballotId);
    await page.close();
  });

  test('follows the meeting when the chair moves to the next question', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(page, pins[1]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'Adopt the minutes');

    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'highest_outright', p_question: chairId, p_open: true, p_only: true,
    });

    await clickByText(page, 'button', 'Reload');
    await waitForText(page, 'Elect the chair');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('Adopt the minutes');

    // Its options are already on screen; nothing to open first.
    await clickWithin(page, '.card', 'Elect the chair', '.choice', 'Ann Meyer');
    await clickWithin(page, '.card', 'Elect the chair', 'button', 'Submit my vote');
    await waitForText(page, 'Your answer is recorded');
    await page.close();
  });

test('exit voting hands the ballot back and asks for a PIN again', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(page, pins[1]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'answered');

    await clickByText(page, 'button', 'Exit voting');
    await page.waitForSelector('.pin-entry', { timeout: 15000 });

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('Submit my vote');
    await page.close();
  });

  test('sees a vote against a gate the chair has since closed refused', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(page, pins[0]!);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'Elect the chair');
    await waitForText(page, 'Ann Meyer');

    // The chair closes it while this voter is still looking at the page.
    await organizer.rpc('close_all_gates', { p_ballot: ballotId });

    await clickWithin(page, '.card', 'Elect the chair', '.choice', 'Ben Naidoo');
    await clickWithin(page, '.card', 'Elect the chair', 'button', 'Submit my vote');
    await waitForText(page, 'not open');
    await page.close();
  });
});

describe('the front page', () => {
  test('turns a PIN into the right ballot, without asking for it twice', async () => {
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });

    const page = await newPage();
    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await enterPin(page, pins[1]!);
    await clickByText(page, 'button', 'Open my ballot');

    // One match goes straight through. Six digits can legitimately exist on a
    // second ballot, which shows a chooser instead -- either is correct.
    await page.waitForFunction(
      () => window.location.hash.startsWith('#/vote/')
        || document.body.innerText.includes('more than one ballot'),
      { timeout: 15000 },
    );
    if (!page.url().includes('#/vote/')) {
      await clickByText(page, '.lobby-item', 'Browser Run');
    }

    // Straight to the questions: the PIN screen is never shown again.
    await waitForText(page, 'Adopt the minutes');
    expect(await page.$('.pin-entry')).toBeNull();
    await page.close();
  });

  test('says so when a PIN opens nothing', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await enterPin(page, '000000');
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'not valid on any open ballot');
    expect(page.url()).not.toContain('#/vote/');
    await page.close();
  });
});

describe('the results page', () => {
  test('withholds a question that is still taking votes', async () => {
    await organizer.from('ballots')
      .update({ status: 'live', results_public: true }).eq('id', ballotId);
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });

    const page = await newPage();
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'still open');

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('Adopt the minutes');
    await page.close();
  });

  test('publishes each question as the chair closes it', async () => {
    // The motion closes, the election opens: one finished, one not.
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'highest_outright', p_question: chairId,
      p_open: true, p_only: true,
    });

    const page = await newPage();
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Adopt the minutes');

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('Elect the chair');
    expect(text).toContain('still open');
    await page.close();
  });

  test('shows the lot once the ballot closes', async () => {
    await organizer.from('ballots').update({ status: 'closed' }).eq('id', ballotId);

    const page = await newPage();
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Browser Run');
    await waitForText(page, 'Adopt the minutes');
    await waitForText(page, 'Elect the chair');
    await waitForText(page, 'Ann Meyer');

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('still open');
    await page.close();

    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
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

describe('the live monitor', () => {
  test('shows the organizer a count the public cannot see, and moves with it', async () => {
    const { email, password } = credentials();
    const page = await newPage();
    await page.setViewport({ width: 1100, height: 900 });

    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    await clickByText(page, 'button', 'Sign in');
    await waitForText(page, 'Your ballots');

    await page.goto(`${origin}/#/live/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Live results');
    await waitForText(page, 'Adopt the minutes');

    // The socket is up, so a change will be pushed rather than waited for.
    await page.waitForSelector('.link-state.live', { timeout: 20000 });

    const before = await countOn(page, 'Adopt the minutes');

    // A vote cast from somewhere else entirely.
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
    await organizer.from('ballots').update({ allow_vote_change: true }).eq('id', ballotId);
    const cast = await anonClient().rpc('cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[1]!, p_question: motionId,
      p_choice: 'yes', p_fingerprint: 'monitor',
    });
    expect((cast.data as { ok: boolean }).ok).toBe(true);

    // No reload: the page notices on its own.
    await page.waitForFunction(
      (prompt: string, was: number) => {
        const card = [...document.querySelectorAll('.monitor-card')].find((c) =>
          (c as HTMLElement).innerText.includes(prompt));
        if (!card) return false;
        const counts = [...card.querySelectorAll('.result-bar .count')]
          .map((n) => Number((n as HTMLElement).innerText.split('·')[0]!.trim()));
        return counts.reduce((a, b) => a + b, 0) > was;
      },
      { timeout: 25000, polling: 300 },
      'Adopt the minutes', before,
    );

    await page.close();
  });
});

/** Total votes shown on one question's card. */
async function countOn(page: Page, prompt: string): Promise<number> {
  return page.evaluate((needle: string) => {
    const card = [...document.querySelectorAll('.monitor-card')].find((c) =>
      (c as HTMLElement).innerText.includes(needle));
    if (!card) return 0;
    return [...card.querySelectorAll('.result-bar .count')]
      .map((n) => Number((n as HTMLElement).innerText.split('\u00b7')[0]!.trim()))
      .reduce((a, b) => a + b, 0);
  }, prompt);
}
