/**
 * A recursion filter run from the chair's Live tab, with a voter's phone open
 * beside it.
 *
 * This is the walk that went wrong in a real meeting: nominations opened, and
 * then the chair could find no way on to round 1, so the voters never saw it.
 * Every step here is a button on the race's own panel, pressed in the browser,
 * and every round has to reach the voter's page with nothing pressed there.
 *
 * Other voters' choices go through the API -- only one phone is under test.
 * Run `bun run build` first. HEADED=1 watches it happen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, clickWithin, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const NAMES = ['Anna Botha', 'Ben Cele', 'Cara Dlamini', 'Dan Els', 'Eve Fourie', 'Finn Gous'];

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let questionId = '';
let pins: string[] = [];
const id: Record<string, string> = {};
let chair: Page;
let phone: Page;
const consoleErrors: string[] = [];

/** The race's own panel: the inner card holding the next step. */
const PANEL = '.card .card';

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

  const { data: ballot, error } = await organizer.from('ballots').insert({
    org_id: orgId, slug: uniqueSlug('e2e-rf'), title: 'Race Run',
    status: 'live', mode: 'gated', allow_vote_change: false,
    results_public: true, show_results_after: true,
  }).select('id').single();
  if (error) throw new Error(error.message);
  ballotId = ballot!.id;

  const { data: q, error: qe } = await organizer.from('questions_recursion_filter').insert({
    ballot_id: ballotId, prompt: 'Choose the secretary', sort_order: 1,
    nominate_max: 2, nominate_threshold: 1, pick_min: 1, pick_max: 1, stop_on_majority: false,
  }).select('id').single();
  if (qe) throw new Error(qe.message);
  questionId = q!.id;

  const { data: opts } = await organizer.from('options_recursion_filter')
    .insert(NAMES.map((label, i) => ({ question_id: questionId, label, sort_order: i })))
    .select('id, label');
  for (const o of opts ?? []) id[o.label] = o.id;

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 3 });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  browser = await launchBrave();
});

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

/** Another voter's choice, straight to the database. */
async function castFor(pin: string, labels: string[]) {
  const { data, error } = await anonClient().rpc('cast_recursion_filter', {
    p_ballot: ballotId, p_pin: pin, p_question: questionId,
    p_options: labels.map((l) => id[l]), p_abstain: false, p_fingerprint: null,
  });
  if (error) throw new Error(error.message);
  if (!(data as { ok: boolean }).ok) throw new Error(JSON.stringify(data));
}

async function race() {
  const { data } = await organizer.from('questions_recursion_filter')
    .select('phase, current_round, gate_open, winner_id').eq('id', questionId).single();
  return data!;
}

/** A tab in the background stalls on clicks; whoever acts comes to the front. */
const act = (page: Page) => page.bringToFront();

/** The names the voter can tap right now, once there are some. */
async function choices(page: Page): Promise<string[]> {
  await page.waitForSelector('.choice', { timeout: 25000 });
  return page.$$eval('.choice', (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());
}


/* ------------------------------------------------------------------------ */

describe('a recursion filter, from the chair\'s panel', () => {
  test('the chair signs in and sees the first step: open nominations', async () => {
    chair = await browser.newPage();
    await chair.setViewport({ width: 1100, height: 900 });
    chair.on('pageerror', (e) => consoleErrors.push(`chair: ${e}`));
    const { email, password } = credentials();
    await chair.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="email"]', { timeout: 15000 });
    await act(chair); await chair.type('input[name="email"]', email);
    await act(chair); await chair.type('input[name="password"]', password);
    await clickByText(chair, 'button', 'Sign in');
    await waitForText(chair, 'Your ballots');

    await chair.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(chair, 'Choose the secretary');
    await waitForText(chair, 'Not opened yet');
    await waitForText(chair, 'Open nominations');
  }, 30000);

  test('the voter waits until nominations open, then sees them on their own', async () => {
    phone = await browser.newPage();
    await phone.setViewport({ width: 420, height: 900 });
    phone.on('pageerror', (e) => consoleErrors.push(`phone: ${e}`));
    await phone.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await act(phone);
    await enterPin(phone, pins[0]!);
    await clickByText(phone, 'button', 'Open my ballot');
    await waitForText(phone, 'No question is open yet');

    await act(chair).then(() => clickWithin(chair, PANEL, 'Nominations', 'button', 'Open nominations'));
    await waitForText(chair, 'Voting');

    await waitForText(phone, 'Choose the secretary', 25000);
    await waitForText(phone, 'Nominate up to 2 people');
    expect((await race()).gate_open).toBe(true);
  }, 60000);

  test('the voter nominates two people', async () => {
    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', '.choice', 'Anna Botha'));
    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', '.choice', 'Ben Cele'));
    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', 'button', 'Submit my vote'));
    await waitForText(phone, 'already voted on this question');

    await castFor(pins[1]!, ['Anna Botha', 'Cara Dlamini']);
    await castFor(pins[2]!, ['Ben Cele', 'Dan Els']);
  }, 30000);

  test('the chair closes nominations from the panel', async () => {
    await waitForText(chair, '3 voted so far', 20000);
    await act(chair).then(() => clickWithin(chair, PANEL, 'voted so far', 'button', 'Close nominations'));
    await waitForText(chair, 'Closed — settle it');
    expect((await race()).gate_open).toBe(false);
    await waitForText(phone, 'No question is open yet', 25000);
  }, 60000);

  test('settling puts the nominated through and offers round 1', async () => {
    await act(chair).then(() => clickWithin(chair, PANEL, 'Closed', 'button', 'Settle nominations'));
    await waitForText(chair, 'Open round 1');
    await waitForText(chair, '4 in this round');
    const r = await race();
    expect(r.phase).toBe('eliminating');
    expect(r.current_round).toBe(1);
  }, 30000);

  test('opening round 1 reaches the voter\'s phone with the shortlist only', async () => {
    await act(chair).then(() => clickWithin(chair, PANEL, 'Round 1', 'button', 'Open round 1'));
    await waitForText(chair, 'Voting');

    await waitForText(phone, 'Round 1', 25000);
    expect(await choices(phone)).toEqual(['Anna Botha', 'Ben Cele', 'Cara Dlamini', 'Dan Els']);

    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', '.choice', 'Anna Botha'));
    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', 'button', 'Submit my vote'));
    await waitForText(phone, 'already voted on this question');
    await castFor(pins[1]!, ['Anna Botha']);
    await castFor(pins[2]!, ['Ben Cele']);
  }, 60000);

  test('the chair sets two to drop, closes and settles round 1', async () => {
    await chair.reload({ waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="drop_count"]', { timeout: 15000 });
    await act(chair); await chair.type('input[name="drop_count"]', '2');
    await act(chair).then(() => clickWithin(chair, PANEL, 'Round 1', 'button', 'Close round 1'));
    await waitForText(chair, 'Closed — settle it');
    await act(chair).then(() => clickWithin(chair, PANEL, 'Closed', 'button', 'Settle round 1'));

    await waitForText(chair, 'Open round 2');
    await waitForText(chair, '2 in this round');
    expect((await race()).current_round).toBe(2);
  }, 60000);

  test('round 2 reaches the phone, and the last settle names the winner', async () => {
    await act(chair).then(() => clickWithin(chair, PANEL, 'Round 2', 'button', 'Open round 2'));
    expect(await choices(phone)).toEqual(['Anna Botha', 'Ben Cele']);

    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', '.choice', 'Anna Botha'));
    await act(phone).then(() => clickWithin(phone, '.card', 'Choose the secretary', 'button', 'Submit my vote'));
    await waitForText(phone, 'already voted on this question');
    await castFor(pins[1]!, ['Anna Botha']);
    await castFor(pins[2]!, ['Ben Cele']);

    await chair.reload({ waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="drop_count"]', { timeout: 15000 });
    await act(chair); await chair.type('input[name="drop_count"]', '1');
    await act(chair).then(() => clickWithin(chair, PANEL, 'Round 2', 'button', 'Close round 2'));
    await waitForText(chair, 'Closed — settle it');
    await act(chair).then(() => clickWithin(chair, PANEL, 'Closed', 'button', 'Settle round 2'));

    await waitForText(chair, 'Won: Anna Botha');
    const r = await race();
    expect(r.phase).toBe('decided');
    expect(r.winner_id).toBe(id['Anna Botha']!);
  }, 60000);

  test('nothing threw in either page', () => {
    expect(consoleErrors).toEqual([]);
  });
});
