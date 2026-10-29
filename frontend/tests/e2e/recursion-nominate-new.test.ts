/**
 * A name called from the floor while nominations are open.
 *
 * The chair types a name that is not on the race's list, and it joins the
 * nominations list there and then: the voter's phone, already showing the
 * nominations, gets the new name without anything pressed there, and the
 * voter can nominate them. After nominations, the same field puts a new name
 * straight into the race.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const NAMES = ['Anna Botha', 'Ben Cele', 'Cara Dlamini'];
const FLOOR = 'Gert Hanekom';
const LATE = 'Hettie Joubert';

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let questionId = '';
let pin = '';
let chair: Page;
let phone: Page;

beforeAll(async () => {
  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);
  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-floor'), title: 'Floor Nominations',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  const { data: q } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: 'Choose the secretary', sort_order: 1 }).select('id').single();
  questionId = q!.id;
  await organizer.from('options_recursion_filter')
    .insert(NAMES.map((label, i) => ({ question_id: questionId, label, sort_order: i })));
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

const choices = (page: Page) =>
  page.$$eval('.choice', (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());

async function typeName(name: string) {
  await chair.bringToFront();
  const input = (await chair.waitForSelector('input[name="nominate_new"]', { timeout: 15000 }))!;
  await input.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await input.click();
  await input.evaluate((e) => { (e as HTMLInputElement).select(); });
  await input.type(name, { delay: 20 });
}

const addButton = (label: string) => chair.evaluate((l: string) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x as HTMLElement).innerText.trim() === l);
  return b ? { disabled: (b as HTMLButtonElement).disabled } : null;
}, label);

describe('a name from the floor', () => {
  test('the chair and a voter are both on the open nominations', async () => {
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'recursion_filter', p_question: questionId, p_open: true,
    });

    chair = await browser.newPage();
    await chair.setViewport({ width: 1100, height: 900 });
    const { email, password } = credentials();
    await chair.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="email"]', { timeout: 15000 });
    await chair.type('input[name="email"]', email);
    await chair.type('input[name="password"]', password);
    await chair.keyboard.press('Enter');
    await waitForText(chair, 'Your ballots');
    await chair.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await waitForText(chair, 'Someone not on the list?');

    phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844 });
    await phone.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(phone, pin);
    await clickByText(phone, 'button', 'Open my ballot');
    await phone.waitForSelector('.choice', { timeout: 20000 });
    expect(await choices(phone)).toEqual([...NAMES].sort());
  }, 60000);

  test('a name already on the list cannot be added twice', async () => {
    await typeName('anna botha ');
    await waitForText(chair, 'is already on the list.');
    expect(await addButton('Add to nominations')).toEqual({ disabled: true });
  }, 30000);

  test('the chair adds a new name, and it reaches the phone on its own', async () => {
    await typeName(FLOOR);
    expect(await addButton('Add to nominations')).toEqual({ disabled: false });
    await clickByText(chair, 'button', 'Add to nominations');
    await waitForText(chair, `${FLOOR} is on the nominations list. Voters can nominate them now.`);
    expect(await chair.$eval('input[name="nominate_new"]', (e) => (e as HTMLInputElement).value)).toBe('');

    await phone.bringToFront();
    await phone.waitForFunction((n: string) =>
      [...document.querySelectorAll('.choice')].some((e) => (e as HTMLElement).innerText.includes(n)),
    { timeout: 25000 }, FLOOR);
    expect(await choices(phone)).toEqual([...NAMES, FLOOR].sort());

    const { data: o } = await organizer.from('options_recursion_filter')
      .select('status, added_by_chair').eq('question_id', questionId).eq('label', FLOOR).single();
    expect(o).toEqual({ status: 'pool', added_by_chair: true });
  }, 60000);

  test('the voter nominates the new name', async () => {
    const b = await phone.evaluateHandle((n: string) =>
      [...document.querySelectorAll('.choice')].find((e) => (e as HTMLElement).innerText.includes(n)), FLOOR);
    await (b.asElement() as import('puppeteer-core').ElementHandle<Element>).evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await (b.asElement() as import('puppeteer-core').ElementHandle<Element>).click();
    await clickByText(phone, 'button', 'Submit my vote');
    await waitForText(phone, `You chose: ${FLOOR}`);

    const { data: votes } = await organizer.from('votes_recursion_filter')
      .select('option_id, options_recursion_filter(label)').eq('question_id', questionId).eq('valid', true);
    expect(votes!.map((v) => (v as unknown as { options_recursion_filter: { label: string } }).options_recursion_filter.label))
      .toEqual([FLOOR]);
  }, 60000);

  test('after nominations, a new name goes straight into the race', async () => {
    await organizer.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'recursion_filter', p_question: questionId, p_open: false,
    });
    await organizer.rpc('settle_round', { p_question: questionId });
    await chair.bringToFront();
    await chair.reload({ waitUntil: 'networkidle0' });
    await waitForText(chair, 'How many seats are being filled?');
    await chair.evaluate(() => {
      const d = [...document.querySelectorAll('details.more-controls')][0] as HTMLDetailsElement;
      d.open = true;
    });
    await waitForText(chair, 'Someone not on the list at all?');
    await typeName(LATE);
    await clickByText(chair, 'button', 'Add to the race');
    await waitForText(chair, `${LATE} is in the race from round 1.`);

    const { data: o } = await organizer.from('options_recursion_filter')
      .select('label, status, joined_round').eq('question_id', questionId).in('label', [FLOOR, LATE]).order('label');
    expect(o).toEqual([
      { label: FLOOR, status: 'in', joined_round: 1 },
      { label: LATE, status: 'in', joined_round: 1 },
    ]);
  }, 60000);
});
