/**
 * The Remove button on a race's list of names, in the Questions tab, while
 * nominations are open.
 *
 * It used to do nothing at all once nominations had opened: the database
 * refused the delete without a word, and the page threw the refusal away.
 * Here the chair removes one name nobody nominated (gone from the list) and
 * one somebody did (kept, marked Removed), fixes a typo in a third, and a
 * voter's phone, open on the nominations, loses the removed names on its own.
 * Each step is checked in the database as well as on the page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, enterPin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const NAMES = ['Anna Botha', 'Ross-lee Botha', 'Cara Dlamni', 'Dan Els'];

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let ballotId = '';
let race = '';
let pins: string[] = [];
const id: Record<string, string> = {};
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
    org_id: org!.id, slug: uniqueSlug('e2e-remove'), title: 'Remove Run',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  const { data: q } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: 'Diakens', sort_order: 1 }).select('id').single();
  race = q!.id;
  const { data: opts } = await organizer.from('options_recursion_filter')
    .insert(NAMES.map((label, i) => ({ question_id: race, label, sort_order: i }))).select('id, label');
  for (const o of opts!) id[o.label] = o.id;
  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 2 });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  // nominations open; one voter has already nominated Dan Els
  await organizer.rpc('set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: race, p_open: true });
  const { data: cast } = await anonClient().rpc('cast_recursion_filter', {
    p_ballot: ballotId, p_pin: pins[1], p_question: race, p_options: [id['Dan Els']],
  });
  if (!(cast as { ok: boolean }).ok) throw new Error(JSON.stringify(cast));
  browser = await launchBrave();
}, 60000);

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

async function row(name: string) {
  const { data } = await organizer.from('options_recursion_filter')
    .select('label, status').eq('id', id[name]!).maybeSingle();
  return data;
}

/** The buttons on one name's row in the editor. */
const rowButtons = (name: string) => chair.evaluate((n: string) => {
  const r = document.querySelector(`[data-option="${n}"]`);
  return r ? [...r.querySelectorAll('button')].map((b) => (b as HTMLElement).innerText.trim()) : null;
}, name);

async function pressRemove(name: string) {
  await chair.bringToFront();
  const button = await chair.waitForFunction((n: string) =>
    [...(document.querySelector(`[data-option="${n}"]`)?.querySelectorAll('button') ?? [])]
      .find((b) => (b as HTMLElement).innerText.trim() === 'Remove' && !(b as HTMLButtonElement).disabled) ?? false,
  { timeout: 15000 }, name);
  const el = button.asElement() as import('puppeteer-core').ElementHandle<Element>;
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await el.click();
}

const phoneChoices = () =>
  phone.$$eval('.choice', (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());

describe('removing a name while nominations are open', () => {
  test('the chair opens the race in the Questions tab; a voter is on the nominations', async () => {
    chair = await browser.newPage();
    await chair.setViewport({ width: 1180, height: 1000 });
    // the confirm("Remove …?") is answered yes, as the chair would
    chair.on('dialog', (d) => void d.accept());
    const { email, password } = credentials();
    await chair.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="email"]', { timeout: 15000 });
    await chair.type('input[name="email"]', email);
    await chair.type('input[name="password"]', password);
    await chair.keyboard.press('Enter');
    await waitForText(chair, 'Your ballots');
    await chair.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await clickByText(chair, 'button', 'Questions');
    await waitForText(chair, 'Diakens');
    await clickByText(chair, 'button', 'Edit');
    await waitForText(chair, 'This vote has started. Remove takes someone off the list');

    // a race under way: Remove only, no Disable, and no adding here
    await chair.waitForSelector('[data-option="Ross-lee Botha"]', { timeout: 15000 });
    expect(await rowButtons('Ross-lee Botha')).toEqual(['Remove']);
    expect(await chair.$('textarea[name="new_options"]')).toBeNull();

    phone = await browser.newPage();
    await phone.setViewport({ width: 390, height: 844 });
    await phone.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
    await enterPin(phone, pins[0]!);
    await clickByText(phone, 'button', 'Open my ballot');
    await phone.waitForSelector('.choice', { timeout: 20000 });
    expect(await phoneChoices()).toEqual([...NAMES].sort());
  }, 60000);

  test('Remove takes off a name nobody nominated', async () => {
    await pressRemove('Ross-lee Botha');
    await waitForText(chair, 'Ross-lee Botha is removed from the nominations.');
    await chair.waitForFunction(() => !document.querySelector('[data-option="Ross-lee Botha"]'), { timeout: 10000 });
    expect(await row('Ross-lee Botha')).toBeNull();

    await phone.bringToFront();
    await phone.waitForFunction(() =>
      ![...document.querySelectorAll('.choice')].some((e) => (e as HTMLElement).innerText.includes('Ross-lee')),
    { timeout: 25000 });
    expect(await phoneChoices()).toEqual(['Anna Botha', 'Cara Dlamni', 'Dan Els']);
  }, 60000);

  test('a name somebody nominated stays on the list, marked Removed', async () => {
    await pressRemove('Dan Els');
    await waitForText(chair, 'Dan Els is removed from the nominations. Their 1 nomination no longer counts.');
    await chair.waitForFunction(() =>
      (document.querySelector('[data-option="Dan Els"]') as HTMLElement | null)?.innerText.includes('Removed') ?? false,
    { timeout: 10000 });
    expect(await rowButtons('Dan Els')).toEqual([]);
    expect(await row('Dan Els')).toEqual({ label: 'Dan Els', status: 'withdrawn' });

    await phone.bringToFront();
    await phone.waitForFunction(() =>
      ![...document.querySelectorAll('.choice')].some((e) => (e as HTMLElement).innerText.includes('Dan Els')),
    { timeout: 25000 });
    expect(await phoneChoices()).toEqual(['Anna Botha', 'Cara Dlamni']);
  }, 60000);

  test('a typo is fixed by editing the name', async () => {
    await chair.bringToFront();
    const input = (await chair.$('[data-option="Cara Dlamni"] input[name="option_label"]'))!;
    await input.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await input.click();
    await input.evaluate((e) => { (e as HTMLInputElement).select(); });
    await input.type('Cara Dlamini', { delay: 20 });
    await chair.keyboard.press('Tab');
    await waitForText(chair, 'Renamed to Cara Dlamini.');
    expect(await row('Cara Dlamni')).toEqual({ label: 'Cara Dlamini', status: 'pool' });

    // a name already on the list is refused, and the box goes back
    const anna = (await chair.waitForSelector('[data-option="Cara Dlamini"] input[name="option_label"]'))!;
    await anna.click();
    await anna.evaluate((e) => { (e as HTMLInputElement).select(); });
    await anna.type('anna botha', { delay: 20 });
    await chair.keyboard.press('Tab');
    await waitForText(chair, 'anna botha is already on the list.');
    expect(await row('Cara Dlamni')).toEqual({ label: 'Cara Dlamini', status: 'pool' });
    expect(await chair.$eval('[data-option="Cara Dlamini"] input[name="option_label"]',
      (e) => (e as HTMLInputElement).value)).toBe('Cara Dlamini');
  }, 60000);
});
