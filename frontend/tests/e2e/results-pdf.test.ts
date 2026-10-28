/**
 * The results page's PDF report, downloaded in a real browser.
 *
 * A ballot with a decided motion and a decided race is published; a reader
 * with no account opens the results, presses "Download PDF", and the file
 * that lands is checked: it is a PDF, it names the ballot, and it carries the
 * outcomes the page shows -- and, for the race, every round, which the page
 * folds away.
 *
 * jsPDF writes its text uncompressed, so the words can be read straight out
 * of the file.
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

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let downloads = '';

const rpc = async (fn: string, args: Record<string, unknown>, client?: SupabaseClient) => {
  const { data, error } = await (client ?? organizer).rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as { ok?: boolean; error?: string };
};

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  downloads = await mkdtemp(join(tmpdir(), 'vs-pdf-'));

  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-pdf'), title: 'Annual Meeting Report',
    status: 'live', mode: 'gated', allow_vote_change: true, results_public: true,
  }).select('id').single();
  ballotId = ballot!.id;

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 3 });
  const pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  // a motion, carried 2 to 1
  const { data: motion } = await organizer.from('questions_yes_no')
    .insert({ ballot_id: ballotId, prompt: 'Adopt the minutes', sort_order: 1 }).select('id').single();
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'yes_no', p_question: motion!.id, p_open: true });
  for (const [i, choice] of (['yes', 'yes', 'no'] as const).entries()) {
    await rpc('cast_yes_no', { p_ballot: ballotId, p_pin: pins[i], p_question: motion!.id, p_choice: choice }, anonClient());
  }
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'yes_no', p_question: motion!.id, p_open: false });

  // a chairperson race, decided by a majority in round 1
  const { data: race } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: 'Elect the chairperson', sort_order: 2 }).select('id').single();
  const { data: people } = await organizer.from('options_recursion_filter')
    .insert(['Alma Muller', 'Bettie van Rensburg'].map((label) => ({ question_id: race!.id, label }))).select('id, label');
  const alma = people!.find((p) => p.label === 'Alma Muller')!.id;
  await rpc('settle_round', { p_question: race!.id, p_shortlist: people!.map((p) => p.id) });
  await rpc('set_race_seats', { p_question: race!.id, p_seats: 1 });
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: true });
  for (const pin of pins) {
    await rpc('cast_recursion_filter', { p_ballot: ballotId, p_pin: pin, p_question: race!.id, p_options: [alma] }, anonClient());
  }
  await rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: false });
  const settled = await rpc('settle_round', { p_question: race!.id });
  if (!settled.ok) throw new Error(JSON.stringify(settled));

  browser = await launchBrave();
}, 60000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
  await rm(downloads, { recursive: true, force: true });
});

describe('the results PDF', () => {
  test('a reader downloads the report, and it carries the outcomes and every round', async () => {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Annual Meeting Report');
    await waitForText(page, 'Carried');
    await clickByText(page, 'button', 'Download PDF');

    let file = '';
    for (let i = 0; i < 60 && !file; i++) {
      await new Promise((r) => setTimeout(r, 250));
      file = (await readdir(downloads)).find((f) => f.endsWith('.pdf')) ?? '';
    }
    expect(file).toMatch(/^annual-meeting-report-results-\d{4}-\d{2}-\d{2}\.pdf$/);

    const pdf = await readFile(join(downloads, file), 'latin1');
    expect(pdf.startsWith('%PDF-')).toBe(true);
    for (const words of [
      'Annual Meeting Report', 'Adopt the minutes', 'Carried', 'Elect the chairperson',
      'Alma Muller', 'Round 1', 'Page 1 of 1',
    ]) {
      expect(pdf).toContain(words);
    }
    await page.close();
  }, 60000);
});
