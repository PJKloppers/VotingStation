/**
 * A race on the live monitor, the screen the room can see.
 *
 *   nominations      the names nominated, never how many times
 *   a round running  the names in it, never the votes coming in -- not even
 *                    with "Hide vote counts" turned off
 *   a round closed   its count, if the chair turns the counts on
 *   the next round   its names only while it runs; the round before keeps
 *                    its count on show
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const NAMES = ['Anna Botha', 'Ben Cele', 'Cara Dlamini', 'Dan Els'];

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let race = '';
let pins: string[] = [];
const id: Record<string, string> = {};
let page: Page;

const rpc = async (fn: string, args: Record<string, unknown>, client?: SupabaseClient) => {
  const { data, error } = await (client ?? organizer).rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  const a = data as { ok?: boolean; error?: string } | null;
  if (a && a.ok === false) throw new Error(`${fn}: ${a.error}`);
  return a;
};
const gate = (open: boolean) =>
  rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race, p_open: open });
const cast = (pin: string, names: string[]) => rpc('cast_recursion_filter',
  { p_ballot: ballotId, p_pin: pin, p_question: race, p_options: names.map((n) => id[n]) }, anonClient());

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-monitor-race'), title: 'Monitor Race',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  const { data: q } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: 'Hoof Diaken', sort_order: 1, stop_on_majority: false })
    .select('id').single();
  race = q!.id;
  const { data: opts } = await organizer.from('options_recursion_filter')
    .insert(NAMES.map((label, i) => ({ question_id: race, label, sort_order: i }))).select('id, label');
  for (const o of opts!) id[o.label] = o.id;
  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 3 });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);
  browser = await launchBrave();
}, 60000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

/** What the race's card shows: the names in its newest round, and any counts or bars. */
const card = () => page.evaluate(() => {
  const c = [...document.querySelectorAll('.monitor-card')].find((x) =>
    (x as HTMLElement).innerText.includes('Hoof Diaken'))!;
  const round = c.querySelector('details.round')!;
  return {
    names: [...round.querySelectorAll('.result-bar .label')].map((n) => n.textContent!.trim()),
    counts: c.querySelectorAll('.result-bar .count').length,
    shownCounts: [...c.querySelectorAll('.result-bar .count')]
      .filter((n) => getComputedStyle(n).visibility !== 'hidden').length,
    bars: [...c.querySelectorAll('.result-bar .track')]
      .filter((n) => getComputedStyle(n).display !== 'none').length,
    text: (c as HTMLElement).textContent ?? '',
  };
});
const toggle = () => page.$eval('input[name="hide_counts"]', (e) => (e as HTMLInputElement).checked);
const setToggle = async (on: boolean) => { if ((await toggle()) !== on) await page.click('input[name="hide_counts"]'); };
/** Waits for the monitor to catch up with the database. */
const until = (fn: string, timeout = 25000) => page.waitForFunction(fn, { timeout, polling: 300 });

describe('a race on the live monitor', () => {
  test('nominations show who was named, never how many times', async () => {
    await gate(true);
    await cast(pins[0]!, ['Anna Botha', 'Ben Cele']);
    await cast(pins[1]!, ['Anna Botha', 'Cara Dlamini']);

    page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1000 });
    const { email, password } = credentials();
    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    await page.keyboard.press('Enter');
    await waitForText(page, 'Your ballots');
    await page.goto(`${origin}/#/live/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Hoof Diaken');
    await page.waitForSelector('.link-state.live', { timeout: 20000 });

    let c = await card();
    expect(c.names.sort()).toEqual(['Anna Botha', 'Ben Cele', 'Cara Dlamini']);
    expect(c.counts).toBe(0);
    expect(c.bars).toBe(0);
    // turning the counts on changes nothing for nominations
    await setToggle(false);
    c = await card();
    expect(c.counts).toBe(0);

    // closed, still no counts
    await gate(false);
    await until(`!document.querySelector('.monitor-card .pill.open')`);
    c = await card();
    expect(c.counts).toBe(0);
    expect(c.text).not.toContain('would');
  }, 60000);

  test('a running round shows its names, not the votes coming in', async () => {
    await rpc('settle_round', { p_question: race });
    await rpc('set_race_seats', { p_question: race, p_seats: 1 });
    await gate(true);
    await until(`!!document.querySelector('.monitor-card .pill.open')`);
    await cast(pins[0]!, ['Anna Botha']);
    await cast(pins[1]!, ['Ben Cele']);
    await cast(pins[2]!, ['Anna Botha']);
    await until(`document.body.textContent.includes('3 voted')`);

    const c = await card();
    expect(c.names.sort()).toEqual(['Anna Botha', 'Ben Cele', 'Cara Dlamini']);
    expect(c.counts).toBe(0);
    expect(c.bars).toBe(0);
    expect(c.text).not.toContain('would drop');
    expect(c.text).not.toContain('would be elected');
  }, 60000);

  test('once the round closes, its count shows -- if the counts are on', async () => {
    await gate(false);
    await until(`[...document.querySelectorAll('.monitor-card .result-bar .count')].length > 0`);
    let c = await card();
    expect(c.shownCounts).toBe(3);
    expect(c.bars).toBe(3);
    expect(c.names).toEqual(['Anna Botha', 'Ben Cele', 'Cara Dlamini']);   // by votes

    // the toggle hides it again
    await setToggle(true);
    c = await card();
    expect(c.shownCounts).toBe(0);
    expect(c.bars).toBe(0);
    await setToggle(false);
  }, 60000);

  test('while round 2 runs it shows only its names; round 1 keeps its result', async () => {
    // Cara (0) drops; round 2 is Anna and Ben
    await rpc('set_round_drop', { p_question: race, p_rule: 'count', p_n: 1 });
    await rpc('settle_round', { p_question: race });
    await gate(true);
    await until(`[...document.querySelectorAll('.monitor-card details.round summary')].some((s) => s.textContent.includes('Round 2'))`);
    await cast(pins[0]!, ['Anna Botha']);
    await until(`document.body.textContent.includes('1 voted')`);

    const rounds = await page.evaluate(() =>
      [...document.querySelectorAll('.monitor-card details.round')].map((d) => ({
        name: d.querySelector('summary')!.textContent!.trim(),
        names: [...d.querySelectorAll('.result-bar .label')].map((n) => n.textContent!.trim()).sort(),
        counts: [...d.querySelectorAll('.result-bar .count')]
          .filter((n) => getComputedStyle(n).visibility !== 'hidden').length,
      })));
    const r2 = rounds.find((r) => r.name.startsWith('Round 2'))!;
    const r1 = rounds.find((r) => r.name.startsWith('Round 1'))!;
    expect(r2.names).toEqual(['Anna Botha', 'Ben Cele']);
    expect(r2.counts).toBe(0);
    expect(r1.counts).toBe(3);
    // the toggle stayed where the chair left it
    expect(await toggle()).toBe(false);
    await page.close();
  }, 60000);
});
