/**
 * A long ballot's PDF report: several pages, numbered, with nothing lost at
 * a page break.
 *
 * Twelve decided motions and a chairperson race drawn from a pool of forty,
 * every one of them nominated, make a report that cannot fit on one page.
 * The test downloads it as a reader would and checks that every page carries
 * "Page n of N" with no gaps, that every question made it in, and that all
 * forty names of the nomination round are there -- the round most likely to
 * be split across a page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser } from 'puppeteer-core';
import { anonClient, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const MOTIONS = Array.from({ length: 12 }, (_, i) => `Motion ${i + 1}: adopt item ${i + 1} of the agenda`);
const SURNAMES = ['Muller', 'van Wyk', 'Haywood', 'du Toit', 'Maree', 'Erasmus', 'Viljoen', 'Mostert',
  'Roode', 'Nebe', 'Lindeque', 'Kruger', 'Burger', 'Steenkamp', 'Pienaar', 'Vosser', 'Wright', 'Jordaan',
  'Weeks', 'Matthysen'];
const PEOPLE = Array.from({ length: 40 }, (_, i) => `${i % 2 ? 'Anna' : 'Bettie'} ${SURNAMES[i % 20]} ${i + 1}`);
const RACE = 'Hoof Diakonnesse';
const VOTERS = 3;

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let downloads = '';

const rpc = async (fn: string, args: Record<string, unknown>, client?: SupabaseClient) => {
  const { data, error } = await (client ?? organizer).rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  const answer = data as { ok?: boolean; error?: string } | null;
  if (answer && answer.ok === false) throw new Error(`${fn}: ${answer.error}`);
  return answer;
};

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  downloads = await mkdtemp(join(tmpdir(), 'vs-pdf-long-'));

  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-pdf-long'), title: 'Long Agenda Meeting',
    status: 'live', mode: 'gated', allow_vote_change: true, results_public: true,
  }).select('id').single();
  ballotId = ballot!.id;

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: VOTERS });
  const pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  // twelve motions, each voted and closed (alternately carried and defeated)
  const { data: motions } = await organizer.from('questions_yes_no')
    .insert(MOTIONS.map((prompt, i) => ({ ballot_id: ballotId, prompt, sort_order: i + 1 })))
    .select('id, sort_order');
  for (const m of motions!) {
    await rpc('set_gate', { p_ballot: ballotId, p_type: 'yes_no', p_question: m.id, p_open: true });
    await Promise.all(pins.map((pin, v) => rpc('cast_yes_no', {
      p_ballot: ballotId, p_pin: pin, p_question: m.id,
      // even motions carried 2 to 1, odd ones defeated 1 to 2
      p_choice: m.sort_order % 2 === 0 ? (v < 2 ? 'yes' : 'no') : (v < 2 ? 'no' : 'yes'),
    }, anonClient())));
    await rpc('set_gate', { p_ballot: ballotId, p_type: 'yes_no', p_question: m.id, p_open: false });
  }

  // a race of forty, everyone nominated, decided by a majority in round 1
  const { data: race } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: RACE, sort_order: 20 }).select('id').single();
  const { data: people } = await organizer.from('options_recursion_filter')
    .insert(PEOPLE.map((label, i) => ({ question_id: race!.id, label, sort_order: i }))).select('id, label');
  const ids = Object.fromEntries(people!.map((p) => [p.label, p.id]));
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: true });
  // nominations are open-ended: each voter names a different third, so all forty are named
  await Promise.all(pins.map((pin, v) => rpc('cast_recursion_filter', {
    p_ballot: ballotId, p_pin: pin, p_question: race!.id,
    p_options: PEOPLE.filter((_, i) => i % VOTERS === v).map((l) => ids[l]),
  }, anonClient())));
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: false });
  await rpc('settle_round', { p_question: race!.id });
  await rpc('set_race_seats', { p_question: race!.id, p_seats: 1 });
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: true });
  await Promise.all(pins.map((pin) => rpc('cast_recursion_filter', {
    p_ballot: ballotId, p_pin: pin, p_question: race!.id, p_options: [ids[PEOPLE[0]!]],
  }, anonClient())));
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: false });
  await rpc('settle_round', { p_question: race!.id });

  browser = await launchBrave();
}, 120000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
  await rm(downloads, { recursive: true, force: true });
});

describe('a long ballot\'s PDF', () => {
  test('runs over several numbered pages and keeps every question and name', async () => {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Long Agenda Meeting');
    await waitForText(page, RACE);
    await clickByText(page, 'button', 'Download PDF');

    let file = '';
    for (let i = 0; i < 80 && !file; i++) {
      await new Promise((r) => setTimeout(r, 250));
      file = (await readdir(downloads)).find((f) => f.endsWith('.pdf')) ?? '';
    }
    expect(file).toMatch(/^long-agenda-meeting-results-\d{4}-\d{2}-\d{2}\.pdf$/);
    const pdf = await readFile(join(downloads, file), 'latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);

    // every page numbered, "Page n of N", with none missing
    const numbers = [...pdf.matchAll(/Page (\d+) of (\d+)/g)];
    const total = Number(numbers[0]?.[2]);
    expect(total).toBeGreaterThanOrEqual(2);
    console.log(`long report: ${total} pages`);
    expect(new Set(numbers.map((m) => Number(m[2])))).toEqual(new Set([total]));
    expect(numbers.map((m) => Number(m[1])).sort((a, b) => a - b))
      .toEqual(Array.from({ length: total }, (_, i) => i + 1));
    // as many pages in the file as the numbering says
    expect((pdf.match(/\/Type \/Page\b/g) ?? []).length).toBe(total);

    // nothing lost at a page break
    for (const m of MOTIONS) expect(pdf).toContain(m);
    expect(pdf).toContain(RACE);
    for (const name of PEOPLE) expect(pdf).toContain(name);
    expect(pdf).toContain('Nominations');
    expect(pdf).toContain('Round 1');
    expect(pdf).toContain(PEOPLE[0]!);
    expect(pdf).toContain('Carried');
    expect(pdf).toContain('Defeated');
    await page.close();
  }, 60000);
});
