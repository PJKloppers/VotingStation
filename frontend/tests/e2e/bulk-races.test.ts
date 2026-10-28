/**
 * Adding several "Narrow it down" races at once, through the Questions tab.
 *
 * The chair opens "Bulk add races", fills one row per race -- what is being
 * asked, which pool, whether a majority ends it -- and adds them all. The
 * test checks the form's guard rails in the browser, then that each race
 * landed with the open defaults, its pool copied in, and in order after the
 * question already on the ballot. Finally a voter sees the first race's
 * nominations with no limit on how many to name.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, ElementHandle, Page } from 'puppeteer-core';
import { credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const ELDERS = ['Adrian Vosser', 'Albert Arnold', 'Andre Human', 'Barry Klopper', 'Brendon Otto', 'Carl Kruger'];
const DEACONS = ['Alma Muller', 'Annelie van Wyk', 'Bettie van Rensburg'];

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let pin = '';
const poolIds: string[] = [];
const stamp = Date.now().toString(36);
const ELDER_POOL = `Elders ${stamp}`;
const DEACON_POOL = `Deacons ${stamp}`;
let page: Page;

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();

  for (const [name, people] of [[ELDER_POOL, ELDERS], [DEACON_POOL, DEACONS]] as const) {
    const { data: pool } = await organizer.from('option_pools')
      .insert({ org_id: org!.id, name }).select('id').single();
    poolIds.push(pool!.id);
    await organizer.from('option_pool_entries')
      .insert(people.map((label, i) => ({ pool_id: pool!.id, label, sort_order: i })));
  }

  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-bulk'), title: 'Church Council',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  // a question already on the ballot: the races go after it
  await organizer.from('questions_yes_no').insert({ ballot_id: ballotId, prompt: 'Open the meeting', sort_order: 1 });
  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 1 });
  pin = (issued as Array<{ pin: string }>)[0]!.pin;

  browser = await launchBrave();
  page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 1000 });
}, 60000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  for (const id of poolIds) await organizer.from('option_pools').delete().eq('id', id);
  await organizer.auth.signOut();
});

/* --------------------------------------------------------------- helpers */

const dialog = async () => (await page.waitForSelector('dialog[open]', { timeout: 10000 }))!;

async function rowField(i: number, name: string): Promise<ElementHandle<Element>> {
  const fields = await (await dialog()).$$(`[name="${name}"]`);
  return fields[i]!;
}

async function typeInto(i: number, text: string) {
  const input = await rowField(i, 'bulk_prompt');
  await input.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await input.click();
  await input.type(text, { delay: 20 });
}

async function choosePool(i: number, label: string) {
  const select = await rowField(i, 'bulk_pool');
  const value = await select.evaluate((s, l) =>
    [...(s as HTMLSelectElement).options].find((o) => o.text === l)?.value ?? '', label);
  expect(value).not.toBe('');
  await (select as ElementHandle<HTMLSelectElement>).select(value);
}

async function pressInDialog(label: string) {
  const handle = await page.waitForFunction((l: string) =>
    [...document.querySelectorAll('dialog[open] button')].find((b) =>
      (b as HTMLElement).innerText.trim() === l) ?? false, { timeout: 10000 }, label);
  const b = handle.asElement() as ElementHandle<Element>;
  await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await b.click();
}

const addButtonDisabled = () => page.evaluate(() => {
  const b = [...document.querySelectorAll('dialog[open] button')].find((x) =>
    /^Add \d+ races?$/.test((x as HTMLElement).innerText.trim()));
  return (b as HTMLButtonElement | undefined)?.disabled ?? null;
});

const dialogText = () => page.evaluate(() => (document.querySelector('dialog[open]') as HTMLElement).innerText);

/* ======================================================================== */

describe('bulk adding races', () => {
  test('the chair opens the bulk form from the Questions tab', async () => {
    const { email, password } = credentials();
    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    await page.keyboard.press('Enter');
    await waitForText(page, 'Your ballots');
    await page.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'Questions');
    await waitForText(page, 'Open the meeting');

    await clickByText(page, 'button', 'Bulk add races');
    await dialog();
    const text = await dialogText();
    expect(text).toContain('What is being asked?');
    expect(text).toContain('Which pool to reuse?');
    expect(text).toContain('Stop as soon as someone has a majority');
    // the pools load into the select
    await page.waitForFunction((n: string) =>
      [...document.querySelectorAll('dialog[open] select[name="bulk_pool"] option')]
        .some((o) => (o as HTMLOptionElement).text === n), { timeout: 10000 }, ELDER_POOL);
    // majority is on by default
    expect(await (await rowField(0, 'bulk_majority')).evaluate((e) => (e as HTMLInputElement).checked)).toBe(true);
  }, 60000);

  test('the button waits until every row has a question and a pool', async () => {
    expect(await addButtonDisabled()).toBe(true);
    expect(await dialogText()).toContain('Race 1 needs a question.');

    await typeInto(0, 'Hoof Ouderling');
    expect(await dialogText()).toContain('Race 1 needs a pool.');
    await choosePool(0, ELDER_POOL);
    expect(await addButtonDisabled()).toBe(false);

    // a second row starts with the pool of the one above
    await pressInDialog('Add another race');
    const second = await rowField(1, 'bulk_pool');
    expect(await second.evaluate((s) => (s as HTMLSelectElement).value)).toBe(poolIds[0]!);
    expect(await addButtonDisabled()).toBe(true);
    expect(await dialogText()).toContain('Race 2 needs a question.');

    // the same question twice is caught
    await typeInto(1, 'hoof ouderling');
    expect(await dialogText()).toContain('Race 2 asks the same as an earlier one.');
    const input = await rowField(1, 'bulk_prompt');
    await input.evaluate((e) => { (e as HTMLInputElement).select(); });
    await input.type('Hoof Diakonnesse', { delay: 20 });
    await choosePool(1, DEACON_POOL);
    await (await rowField(1, 'bulk_majority')).click();          // this one runs to the last one in

    // a third row, added and taken away again
    await pressInDialog('Add another race');
    expect((await (await dialog()).$$('[name="bulk_prompt"]')).length).toBe(3);
    const removes = await page.$$('dialog[open] button');
    for (const b of removes.reverse()) {
      if ((await b.evaluate((e) => (e as HTMLElement).innerText.trim())) === 'Remove') { await b.click(); break; }
    }
    expect((await (await dialog()).$$('[name="bulk_prompt"]')).length).toBe(2);
    expect(await addButtonDisabled()).toBe(false);
    expect(await dialogText()).toContain('Add 2 races');
  }, 60000);

  test('adding them makes both races, after the question already there', async () => {
    await pressInDialog('Add 2 races');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 20000 });
    await waitForText(page, '2 races added.');
    await waitForText(page, 'Hoof Ouderling');
    await waitForText(page, 'Hoof Diakonnesse');

    const { data: races } = await organizer.from('questions_recursion_filter')
      .select('id, prompt, sort_order, seats, nominate_max, nominate_threshold, pick_min, pick_max, stop_on_majority, allow_abstain')
      .eq('ballot_id', ballotId).order('sort_order');
    expect(races!.map((r) => [r.prompt, r.sort_order, r.stop_on_majority])).toEqual([
      ['Hoof Ouderling', 2, true],
      ['Hoof Diakonnesse', 3, false],
    ]);
    for (const r of races!) {
      expect(r).toMatchObject({
        seats: 1, nominate_max: null, nominate_threshold: 1, pick_min: 1, pick_max: null, allow_abstain: false,
      });
    }
    // each pool copied into its own race
    for (const [r, people] of [[races![0]!, ELDERS], [races![1]!, DEACONS]] as const) {
      const { data: opts } = await organizer.from('options_recursion_filter')
        .select('label, status').eq('question_id', r.id);
      expect(opts!.map((o) => o.label).sort()).toEqual([...people].sort());
      expect(new Set(opts!.map((o) => o.status))).toEqual(new Set(['pool']));
    }
  }, 60000);

  test('a voter may nominate anyone in the first race\'s pool', async () => {
    const { data: race } = await organizer.from('questions_recursion_filter')
      .select('id').eq('ballot_id', ballotId).eq('prompt', 'Hoof Ouderling').single();
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'recursion_filter', p_question: race!.id, p_open: true, p_only: true,
    });
    const voter = await browser.newPage();
    await voter.setViewport({ width: 390, height: 844 });
    await voter.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(voter, pin);
    await clickByText(voter, 'button', 'Open my ballot');
    await waitForText(voter, 'Hoof Ouderling');
    await waitForText(voter, 'Nominate as many people as you like.');
    expect((await voter.$$('.choice')).length).toBe(ELDERS.length);
    await voter.close();
  }, 60000);
});
