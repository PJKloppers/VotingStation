/**
 * Adding a "Narrow it down" race through the Questions tab, and what its
 * defaults let a voter do.
 *
 * The form no longer asks for seats: the chair confirms those after
 * nominations. "Nominations per voter" and "Pick at most" start blank, and
 * blank means no limit beyond the list itself -- a voter may nominate
 * everyone in the pool.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const NAMES = ['Alma Muller', 'Annelie van Wyk', 'Bettie van Rensburg', 'Carmen Haywood', 'Chere du Toit'];

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let questionId = '';
let pin = '';

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-setup'), title: 'Setup Run',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 1 });
  pin = (issued as Array<{ pin: string }>)[0]!.pin;
  browser = await launchBrave();
}, 60000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

const scrolledClick = async (page: Page, selector: string) => {
  await page.$eval(selector, (e) => e.scrollIntoView({ block: 'center' }));
  await page.click(selector);
};

describe('a race added through the form', () => {
  test('asks for no seats, and leaves both limits open', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1180, height: 1000 });
    const { email, password } = credentials();
    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    await page.keyboard.press('Enter');
    await waitForText(page, 'Your ballots');

    await page.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'Questions');
    await waitForText(page, 'What kind of question?');
    await clickByText(page, 'button', 'Narrow it down');
    await page.waitForSelector('input[name="new_question"]', { timeout: 10000 });
    await page.type('input[name="new_question"]', 'Hoof Diakonnesse');
    await page.waitForSelector('textarea[name="add_options"]', { timeout: 10000 });
    await page.type('textarea[name="add_options"]', NAMES.join('\n'));

    await page.waitForSelector('input[name="add_nominate_max"]', { timeout: 10000 });
    expect(await page.$('input[name="add_seats"]')).toBeNull();
    expect(await page.$eval('input[name="add_nominate_max"]', (e) => (e as HTMLInputElement).value)).toBe('');
    expect(await page.$eval('input[name="add_max"]', (e) => (e as HTMLInputElement).value)).toBe('');
    expect(await page.$eval('input[name="add_max"]', (e) => (e as HTMLInputElement).placeholder)).toBe('Everyone');
    await waitForText(page, 'asked after nominations, before round 1');

    await scrolledClick(page, 'button[type="submit"].primary');
    await waitForText(page, 'Hoof Diakonnesse');

    const { data: q } = await organizer.from('questions_recursion_filter')
      .select('id, seats, nominate_max, pick_max, pick_min').eq('ballot_id', ballotId).single();
    expect(q).toMatchObject({ seats: 1, nominate_max: null, pick_max: null, pick_min: 1 });
    questionId = q!.id;
    const { count } = await organizer.from('options_recursion_filter')
      .select('id', { count: 'exact', head: true }).eq('question_id', questionId);
    expect(count).toBe(NAMES.length);
    await page.close();
  }, 60000);

  test('a voter may nominate everyone in the pool', async () => {
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'recursion_filter', p_question: questionId, p_open: true,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(page, pin);
    await clickByText(page, 'button', 'Open my ballot');
    await waitForText(page, 'Nominate as many people as you like.');

    const buttons = await page.$$('.choice');
    expect(buttons).toHaveLength(NAMES.length);
    for (const b of buttons) {
      await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await b.click();
    }
    await clickByText(page, 'button', 'Submit my vote');
    await waitForText(page, 'Your answer is recorded');
    await waitForText(page, 'You chose: Alma Muller, Annelie van Wyk, Bettie van Rensburg and 2 more');

    const { count } = await organizer.from('votes_recursion_filter')
      .select('id', { count: 'exact', head: true }).eq('question_id', questionId).eq('valid', true);
    expect(count).toBe(NAMES.length);
    await page.close();
  }, 60000);
});
