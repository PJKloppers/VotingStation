/**
 * The organizer's own path through the browser, from an empty ballot to a
 * published one.
 *
 * This is the half the voter suite never walks. It exists because the "New
 * ballot" button was broken for the life of the project and nothing caught it:
 * every other test created its ballots through the API with `status: 'live'`,
 * and a ballot made through the UI is born a draft. A test that only ever
 * reaches the finished state cannot see a door that will not open.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, clickWithin, decodeBarcode, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let createdBallotId = '';

const title = `Committee Meeting ${Date.now().toString(36)}`;

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

  if (!org) {
    await organizer.from('organizations')
      .insert({ owner_id: user.user!.id, slug: uniqueSlug('e2e-org'), name: 'E2E Org' });
  }

  browser = await launchBrave();
});

afterAll(async () => {
  await browser?.close();
  stop?.();
  if (createdBallotId) await organizer.from('ballots').delete().eq('id', createdBallotId);
  await organizer.auth.signOut();
});

async function signedInPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  const { email, password } = credentials();
  await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  await page.type('input[name="email"]', email);
  await page.type('input[name="password"]', password);
  await clickByText(page, 'button', 'Sign in');
  await waitForText(page, 'Your ballots');
  return page;
}

/** The id of the ballot the Manage page is currently showing. */
const ballotIdFromUrl = (page: Page) =>
  page.url().split('#/manage/')[1]?.split('?')[0] ?? '';

describe('creating a ballot in the browser', () => {
  test('the New ballot button makes a draft and opens it', async () => {
    const page = await signedInPage();

    await clickByText(page, 'button', 'New ballot');
    await page.waitForSelector('input[name="ballot_title"]', { timeout: 15000 });
    await page.type('input[name="ballot_title"]', title);
    await clickByText(page, 'button', 'Create ballot');

    // Lands on the new ballot's own page, as a draft.
    await waitForText(page, title);
    await waitForText(page, 'draft');
    await page.waitForFunction(
      () => window.location.hash.startsWith('#/manage/'),
      { timeout: 15000 },
    );

    createdBallotId = ballotIdFromUrl(page);
    expect(createdBallotId).toMatch(/^[0-9a-f-]{36}$/);

    const { data: row } = await organizer.from('ballots')
      .select('id, status, title').eq('id', createdBallotId).single();
    expect(row!.status).toBe('draft');
    expect(row!.title).toBe(title);

    await page.close();
  });

  test('the draft is nobody else\'s business yet', async () => {
    const { data } = await anonClient().from('ballots')
      .select('id').eq('id', createdBallotId).maybeSingle();
    expect(data).toBeNull();
  });

  test('a question can be added to it', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);

    await clickByText(page, 'button', 'Questions');
    await page.waitForSelector('input[name="new_question"]', { timeout: 15000 });
    await page.type('input[name="new_question"]', 'Approve the agenda');
    await clickByText(page, 'button', 'Add question');
    await waitForText(page, 'Approve the agenda');

    const { data } = await organizer.from('questions_yes_no')
      .select('id, prompt').eq('ballot_id', createdBallotId);
    expect(data).toHaveLength(1);
    expect(data![0]!.prompt).toBe('Approve the agenda');

    await page.close();
  });


  test('a whole column of options can be pasted in at once', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);
    await clickByText(page, 'button', 'Questions');

    // An election, which is the kind of question that has options.
    await page.waitForSelector('select', { timeout: 15000 });
    await page.select('select', 'highest_outright');
    await page.type('input[name="new_question"]', 'Elect the secretary');
    await clickByText(page, 'button', 'Add question');
    await waitForText(page, 'Elect the secretary');

    // That question's own editor -- the yes/no one above it also has an Edit
    // button, and it has no options at all.
    await clickWithin(page, '.card', 'Elect the secretary', 'button', 'Edit');
    await page.waitForSelector('textarea[name="new_options"]', { timeout: 15000 });

    // Commas, newlines and a quoted comma all in one paste.
    await page.type('textarea[name="new_options"]',
      'Ann Meyer, Ben Naidoo\n"Dlamini, Cara"\nAnn Meyer');

    // The repeat is recognised before anything is sent.
    await waitForText(page, 'Add 3 options');
    await clickWithin(page, '.card', 'Elect the secretary', 'button', 'Add 3 options');

    // The labels live in input values, which innerText does not carry, so read
    // the fields themselves.
    await page.waitForFunction(
      () => document.querySelectorAll('input[name="option_label"]').length === 3,
      { timeout: 15000 },
    );
    const onScreen = await page.$$eval('input[name="option_label"]',
      (nodes) => nodes.map((n) => (n as HTMLInputElement).value));
    expect(onScreen).toEqual(['Ann Meyer', 'Ben Naidoo', 'Dlamini, Cara']);

    const { data: q } = await organizer.from('questions_highest_outright')
      .select('id').eq('ballot_id', createdBallotId).single();
    const { data: opts } = await organizer.from('options_highest_outright')
      .select('label').eq('question_id', q!.id).order('sort_order');

    expect(opts!.map((o) => o.label)).toEqual(['Ann Meyer', 'Ben Naidoo', 'Dlamini, Cara']);
    await page.close();
  });

test('the Issue PINs button mints them and lists them', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);
    await clickByText(page, 'button', 'PINs');

    await page.waitForSelector('input[name="pin_count"]', { timeout: 15000 });
    await page.focus('input[name="pin_count"]');
    // Select what is there and replace it, rather than appending to it.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('3');

    // The button says what it is about to do, so it is also the assertion.
    await clickByText(page, 'button', 'Issue 3 PINs');

    await page.waitForFunction(
      () => document.querySelectorAll('.pin-chip').length === 3,
      { timeout: 15000 },
    );
    const shown = await page.$$eval('.pin-chip .pin',
      (nodes) => nodes.map((n) => (n as HTMLElement).innerText.trim()));
    expect(shown).toHaveLength(3);
    for (const pin of shown) expect(pin).toMatch(/^[0-9]{6}$/);

    const report = await organizer.rpc('ballot_token_report', { p_ballot: createdBallotId });
    const data = report.data as { issued: number; tokens: Array<Record<string, unknown>> };
    expect(data.issued).toBe(3);
    expect(data.tokens[0]).not.toHaveProperty('label');

    // And they are on the page's own list, not only in the just-issued strip.
    const rows = await page.$$eval('table tbody tr', (n) => n.length);
    expect(rows).toBe(3);

    await page.close();
  });

test('the print sheet makes one slip per active PIN', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });

    // Headless has no dialog; stub it so the press cannot block.
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');
    await page.waitForSelector('.print-sheet .slip', { timeout: 15000 });

    const slips = await page.$$eval('.slip', (nodes) => nodes.length);
    const pinsOnSlips = await page.$$eval('.slip-pin',
      (nodes) => nodes.map((n) => (n as HTMLElement).textContent!.trim()));

    const { data } = await organizer.from('ballot_tokens')
      .select('pin').eq('ballot_id', createdBallotId).eq('status', 'active');
    expect(slips).toBe((data ?? []).length);
    expect(pinsOnSlips.sort()).toEqual((data ?? []).map((t) => t.pin).sort());

    // Each slip carries the ballot and a scannable way in.
    const titles = await page.$$eval('.slip-title',
      (nodes) => nodes.map((n) => (n as HTMLElement).textContent!.trim()));
    expect(new Set(titles)).toEqual(new Set([title]));
    expect(await page.$$eval('.slip-qr', (n) => n.length)).toBe(slips);

    // On screen it is invisible; on paper it is the only thing there.
    const onScreen = await page.$eval('.print-sheet',
      (n) => getComputedStyle(n).display);
    expect(onScreen).toBe('none');

    await page.emulateMediaType('print');
    const onPaper = await page.evaluate(() => ({
      sheet: getComputedStyle(document.querySelector('.print-sheet')!).display,
      chrome: getComputedStyle(document.querySelector('.topbar')!).display,
    }));
    expect(onPaper.sheet).not.toBe('none');
    expect(onPaper.chrome).toBe('none');

    await page.emulateMediaType(undefined);
    await page.close();
  });

test('sixteen slips to a page, whatever the paper and the scale', async () => {
    // An earlier version fixed the row height in millimetres and only measured
    // A4 and Letter at a zero margin, which is not what a print dialog does. At
    // 110% scale -- one click in Chrome's print preview -- the last row stopped
    // fitting and every page quietly dropped a pair.
    if (process.env.HEADED === '1') return;   // page.pdf needs headless

    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    const { data: b } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('paper'), title: 'Paper check', status: 'draft',
    }).select('id').single();
    const paper = b!.id;

    const minted = await organizer.rpc('issue_tokens', { p_ballot: paper, p_count: 32 });
    const last = (minted.data as Array<{ pin: string }>)[31]!.pin;

    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${paper}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');
    await page.waitForSelector('.print-sheet .slip', { timeout: 15000 });

    const margin = (v: string) => ({ top: v, right: v, bottom: v, left: v });
    const pagesOf = async (opts: Record<string, unknown>) => {
      const pdf = await page.pdf({ printBackground: true, ...opts });
      return (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    };

    const settings: Array<[string, Record<string, unknown>]> = [
      ['A4',                     { format: 'A4', margin: margin('0.4in') }],
      ['A4 wide margins',        { format: 'A4', margin: margin('1in') }],
      ['A4 headers and footers', { format: 'A4', margin: margin('1in'), displayHeaderFooter: true }],
      ['A4 at 125%',             { format: 'A4', margin: margin('0.4in'), scale: 1.25 }],
      ['A4 at 150%',             { format: 'A4', margin: margin('0.4in'), scale: 1.5 }],
      ['A4 landscape',           { format: 'A4', landscape: true, margin: margin('0.4in') }],
      ['Letter',                 { format: 'Letter', margin: margin('1in') }],
      ['Legal',                  { format: 'Legal', margin: margin('1in') }],
      ['A5',                     { format: 'A5', margin: margin('0.4in') }],
    ];

    // Sixteen to a sheet: 32 slips is two, on every one of these.
    expect(await page.$$eval('.print-page', (n) => n.length)).toBe(2);
    expect(await page.$$eval('.print-page:first-child .slip', (n) => n.length)).toBe(16);

    for (const [name, opts] of settings) {
      expect(`${name}: ${await pagesOf(opts)}`).toBe(`${name}: 2`);
    }

    // Take one out of circulation: the sheet prints only the active ones.
    await organizer.from('ballot_tokens')
      .update({ status: 'disabled' }).eq('ballot_id', paper).eq('pin', last);
    await page.reload({ waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');
    await page.waitForFunction(
      () => document.querySelectorAll('.slip').length === 31, { timeout: 15000 });
    expect(await pagesOf({ format: 'A4', margin: margin('0.4in') })).toBe(2);

    await page.close();
    await organizer.from('ballots').delete().eq('id', paper);
  });

  test('publishing it opens the ballot to voters', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);

    await clickByText(page, 'button', 'Publish');
    await page.waitForSelector('.pill.live', { timeout: 15000 });

    const { data } = await organizer.from('ballots')
      .select('status').eq('id', createdBallotId).single();
    expect(data!.status).toBe('live');

    // The front page is a camera and a link box; a published ballot is reached
    // by its own link, not by browsing to it.
    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="ballot_link"]', { timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).not.toContain(title);
    expect(body).not.toContain('browse organizations');
    expect(await page.$('.pin-entry')).toBeNull();   // the PIN belongs on the ballot

    await page.close();
  });
});

describe('deleting a ballot', () => {
  let doomed = '';

  beforeAll(async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    const { data } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('doomed'), title: 'Ballot to delete', status: 'draft',
    }).select('id').single();
    doomed = data!.id;
  });

  afterAll(async () => {
    if (doomed) await organizer.from('ballots').delete().eq('id', doomed);
  });

  test('asks for the title, and will not go through on the wrong one', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${doomed}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Ballot to delete');
    await clickByText(page, 'button', 'Settings');
    await waitForText(page, 'Danger');

    await clickByText(page, 'button', 'Delete ballot');
    await page.waitForSelector('input[name="confirm_title"]', { timeout: 15000 });

    await page.type('input[name="confirm_title"]', 'Ballot to delet');   // one short
    const stillThere = await page.$$eval('button',
      (nodes) => nodes.filter((n) => n.innerText.trim() === 'Delete for good')
                      .map((n) => (n as HTMLButtonElement).disabled));
    expect(stillThere).toEqual([true]);

    const { data } = await organizer.from('ballots').select('id').eq('id', doomed).maybeSingle();
    expect(data).not.toBeNull();

    await page.close();
  });

  test('goes through on the right one, and lands back on the list', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${doomed}`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Ballot to delete');
    await clickByText(page, 'button', 'Settings');
    await clickByText(page, 'button', 'Delete ballot');
    await page.waitForSelector('input[name="confirm_title"]', { timeout: 15000 });

    await page.type('input[name="confirm_title"]', 'Ballot to delete');
    await clickByText(page, 'button', 'Delete for good');

    await page.waitForFunction(() => window.location.hash === '#/admin', { timeout: 15000 });
    await waitForText(page, 'Your ballots');

    const { data } = await organizer.from('ballots').select('id').eq('id', doomed).maybeSingle();
    expect(data).toBeNull();
    doomed = '';

    await page.close();
  });
});

describe('deleting from the dashboard list', () => {
  // Where a stray ballot is actually noticed. A draft has nothing to lose, so
  // one confirmation is enough; anything published has votes behind it and
  // costs the same typed title as the Settings tab.
  let draft = '';
  let published = '';
  let orgId = '';

  const make = async (title: string, status: 'draft' | 'live') => {
    const { data } = await organizer.from('ballots').insert({
      org_id: orgId, slug: uniqueSlug('listdel'), title, status,
    }).select('id').single();
    return data!.id;
  };

  beforeAll(async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    orgId = org!.id;
    draft = await make('Stray draft', 'draft');
    published = await make('Published run', 'live');
  });

  afterAll(async () => {
    for (const id of [draft, published]) {
      if (id) await organizer.from('ballots').delete().eq('id', id);
    }
  });

  test('a draft goes in two clicks, without leaving the list', async () => {
    const page = await signedInPage();
    await waitForText(page, 'Stray draft');

    await clickWithin(page, '.ballot-row', 'Stray draft', 'button', 'Delete');
    await clickWithin(page, '.ballot-row', 'Stray draft', 'button', 'Delete for good');

    await page.waitForFunction(
      () => !document.body.innerText.includes('Stray draft'),
      { timeout: 15000 },
    );
    expect(page.url()).toContain('#/admin');

    const { data } = await organizer.from('ballots').select('id').eq('id', draft).maybeSingle();
    expect(data).toBeNull();
    draft = '';
    await page.close();
  });

  test('a published ballot asks for its title first', async () => {
    const page = await signedInPage();
    await waitForText(page, 'Published run');

    await clickWithin(page, '.ballot-row', 'Published run', 'button', 'Delete');
    await page.waitForSelector('.ballot-row input[name="confirm_title"]', { timeout: 15000 });

    // Armed but not typed: still refused.
    const disabled = await page.$$eval('.ballot-row button',
      (nodes) => nodes.filter((n) => n.innerText.trim() === 'Delete for good')
                      .map((n) => (n as HTMLButtonElement).disabled));
    expect(disabled).toEqual([true]);

    await page.type('.ballot-row input[name="confirm_title"]', 'Published run');
    await clickWithin(page, '.ballot-row', 'Published run', 'button', 'Delete for good');

    await page.waitForFunction(
      () => !document.body.innerText.includes('Published run'),
      { timeout: 15000 },
    );
    const { data } = await organizer.from('ballots').select('id').eq('id', published).maybeSingle();
    expect(data).toBeNull();
    published = '';
    await page.close();
  });

  test('cancelling leaves the ballot alone', async () => {
    const keep = await make('Keep this one', 'live');
    const page = await signedInPage();
    await waitForText(page, 'Keep this one');

    await clickWithin(page, '.ballot-row', 'Keep this one', 'button', 'Delete');
    await page.waitForSelector('.ballot-row input[name="confirm_title"]', { timeout: 15000 });
    await clickWithin(page, '.ballot-row', 'Keep this one', 'button', 'Cancel');

    await page.waitForFunction(
      () => !document.querySelector('.ballot-row input[name="confirm_title"]'),
      { timeout: 15000 },
    );
    await waitForText(page, 'Keep this one');

    const { data } = await organizer.from('ballots').select('id').eq('id', keep).maybeSingle();
    expect(data).not.toBeNull();

    await organizer.from('ballots').delete().eq('id', keep);
    await page.close();
  });
});

describe('an organization\'s mark', () => {
  // A 2x2 teal PNG is enough: what is being tested is that it reaches the three
  // places a voter sees it, not what it looks like.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNkYPhfz0AEYBxVSF+FAP5FBAXn8ZgIAAAAAElFTkSuQmCC',
    'base64',
  );
  let orgId = '';
  let pngPath = '';

  beforeAll(async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    orgId = org!.id;

    // The file chooser takes a path on disk, not bytes.
    pngPath = `${tmpdir()}/votingstation-mark-${Date.now()}.png`;
    await Bun.write(pngPath, png);
  });

  afterAll(async () => {
    if (pngPath) await rm(pngPath, { force: true });
    const { data } = await organizer.from('organization_images')
      .select('path').eq('org_id', orgId).eq('kind', 'logo').maybeSingle();
    if (data) {
      await organizer.from('organization_images').delete().eq('org_id', orgId).eq('kind', 'logo');
      await organizer.storage.from('org-logos').remove([data.path]);
    }
  });

  test('the settings modal takes one, and the card shows it', async () => {
    const page = await signedInPage();

    await clickByText(page, 'button', 'Settings');
    await page.waitForSelector('dialog.modal[open]', { timeout: 15000 });
    await waitForText(page, 'Mark');

    // The control renders once it knows whether there is a mark already.
    await page.waitForSelector('input[name="org_logo"]', { timeout: 15000 });
    const chooser = await page.$('input[name="org_logo"]');
    await chooser!.uploadFile(pngPath);

    await page.waitForSelector('.org-mark-frame img', { timeout: 15000 });
    await clickByText(page, 'button', 'Close');

    // It is stored, not merely shown.
    const { data } = await organizer.from('organization_images')
      .select('path').eq('org_id', orgId).eq('kind', 'logo').single();
    expect(data!.path.startsWith(`${orgId}/`)).toBe(true);

    await page.waitForSelector('.org-thumb img', { timeout: 15000 });
    await page.close();
  });

  test('a voter sees it on the ballot, with no account at all', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', createdBallotId);

    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });
    await page.goto(`${origin}/#/vote/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.ballot-mark', { timeout: 15000 });

    const loaded = await page.$eval('.ballot-mark',
      (n) => (n as HTMLImageElement).naturalWidth > 0);
    expect(loaded).toBe(true);   // it actually fetched, not just rendered a broken img
    await page.close();
  });

  test('it reaches the printed slips, and the codes still scan', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');

    // Inlined as a data URI, because window.print() will not wait for a fetch.
    await page.waitForSelector('.slip-qr image', { timeout: 15000 });
    const href = await page.$eval('.slip-qr image',
      (n) => n.getAttribute('href') ?? n.getAttribute('xlink:href') ?? '');
    expect(href.startsWith('data:image/')).toBe(true);

    // Dead centre of the code, or it is covering something it should not.
    const centred = await page.$eval('.slip-qr', (svg) => {
      const img = svg.querySelector('image')!;
      const span = (svg as SVGSVGElement).viewBox.baseVal.width;
      const x = Number(img.getAttribute('x'));
      const w = Number(img.getAttribute('width'));
      return Math.abs((x + w / 2) - span / 2) < 0.01 && w / span < 0.3;
    });
    expect(centred).toBe(true);

    expect(await page.$$eval('.slip-mark', (n) => n.length))
      .toBe(await page.$$eval('.slip', (n) => n.length));

    await page.close();
  });
});


describe('the printed link', () => {
  // A slip is read by a person and typed by one, so it carries the pair of
  // slugs rather than a uuid -- and that link has to land on this ballot.
  let orgSlug = '';
  let ballotSlug = '';
  let scratch = '';

  beforeAll(async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id, slug').eq('owner_id', user.user!.id).limit(1).single();
    orgSlug = org!.slug;
    ballotSlug = uniqueSlug('linked');

    const { data: b } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: ballotSlug, title: 'Linked Ballot', status: 'live',
    }).select('id').single();
    scratch = b!.id;
    await organizer.rpc('issue_tokens', { p_ballot: scratch, p_count: 2 });
  });

  afterAll(async () => {
    if (scratch) await organizer.from('ballots').delete().eq('id', scratch);
  });

  test('the slip prints the slugs, not the uuid', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${scratch}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');
    await page.waitForSelector('.slip-url', { timeout: 15000 });

    const shown = await page.$eval('.slip-url', (n) => n.textContent ?? '');
    expect(shown).toContain(`/vote/${orgSlug}/${ballotSlug}`);
    expect(shown).not.toContain(scratch);
    await page.close();
  });

  test('and the code on it decodes to that same link', async () => {
    const page = await signedInPage();
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 3 });
    await page.goto(`${origin}/#/manage/${scratch}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    await clickByText(page, 'button', 'Print slips');
    await page.waitForSelector('.slip-qr', { timeout: 15000 });
    await page.emulateMediaType('print');

    const expected = `${origin}/#/vote/${orgSlug}/${ballotSlug}`;
    const codes = await page.$$('.slip-qr');
    expect(codes.length).toBeGreaterThan(0);

    for (const code of codes) {
      const png = PNG.sync.read(Buffer.from(await code.screenshot({ encoding: 'binary' }) as Buffer));
      const found = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      // The mark sits in the middle of it, so this is also the check that the
      // patch stays inside what error correction level M can recover.
      expect(found?.data).toBe(expected);
    }
    await page.emulateMediaType(undefined);
    await page.close();
  });

  test('following that link lands on this ballot and no other', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });
    await page.goto(`${origin}/#/vote/${orgSlug}/${ballotSlug}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.pin-entry', { timeout: 15000 });
    await waitForText(page, 'Linked Ballot');
    await page.close();
  });

  test('a link with the wrong slugs finds nothing', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#/vote/${orgSlug}/no-such-ballot`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'not point at a published ballot');
    expect(await page.$('.pin-entry')).toBeNull();
    await page.close();
  });
});

describe('putting the PIN in the code', () => {
  // Off by default, because it makes the printed code the credential.
  let scratch = '';
  let orgSlug = '';
  let ballotSlug = '';
  let pins: string[] = [];

  beforeAll(async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id, slug').eq('owner_id', user.user!.id).limit(1).single();
    orgSlug = org!.slug;
    ballotSlug = uniqueSlug('embed');

    const { data: b } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: ballotSlug, title: 'Embedded Ballot', status: 'live',
    }).select('id').single();
    scratch = b!.id;

    const { data: q } = await organizer.from('questions_yes_no').insert({
      ballot_id: scratch, prompt: 'Carry the motion', sort_order: 1,
    }).select('id').single();
    await organizer.rpc('set_gate', {
      p_ballot: scratch, p_type: 'yes_no', p_question: q!.id, p_open: true, p_only: true,
    });

    const minted = await organizer.rpc('issue_tokens', { p_ballot: scratch, p_count: 3 });
    pins = (minted.data as Array<{ pin: string }>).map((t) => t.pin);
  });

  afterAll(async () => {
    if (scratch) await organizer.from('ballots').delete().eq('id', scratch);
  });

  const printed = async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${scratch}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 15000 });
    await page.evaluate(() => { window.print = () => {}; });
    return page;
  };

  test('is off unless it is switched on', async () => {
    const page = await printed();
    const ticked = await page.$$eval('input[type="checkbox"]',
      (boxes) => boxes.map((b) => (b as HTMLInputElement).checked));
    expect(ticked.some((t) => t)).toBe(false);

    await clickByText(page, 'button', 'Print slips');
    await page.waitForSelector('.slip-url', { timeout: 15000 });

    // Every slip carries the same link, and none of them a PIN.
    const links = await page.$$eval('.slip-url', (n) => n.map((x) => x.textContent ?? ''));
    expect(new Set(links).size).toBe(1);
    for (const l of links) expect(l).not.toContain('pin=');
    await page.close();
  });

  test('switched on, every slip carries its own', async () => {
    const page = await printed();
    await clickByText(page, 'label', 'Put the PIN in the code as well');
    await clickByText(page, 'button', 'Print slips');
    await page.waitForFunction(
      () => document.querySelectorAll('.slip-url').length === 3, { timeout: 15000 });

    const links = await page.$$eval('.slip-url', (n) => n.map((x) => x.textContent ?? ''));
    expect(new Set(links).size).toBe(3);            // each one different
    for (const pin of pins) {
      expect(links.some((l) => l.includes(`pin=${pin}`))).toBe(true);
    }
    await page.close();
  });

  test('and the code on it decodes to that voter\'s own link', async () => {
    const page = await printed();
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 3 });
    await clickByText(page, 'label', 'Put the PIN in the code as well');
    await clickByText(page, 'button', 'Print slips');
    await page.waitForFunction(
      () => document.querySelectorAll('.slip-qr').length === 3, { timeout: 15000 });
    await page.emulateMediaType('print');

    const decoded: string[] = [];
    for (const qr of await page.$$('.slip-qr')) {
      const png = PNG.sync.read(Buffer.from(await qr.screenshot({ encoding: 'binary' }) as Buffer));
      const found = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      decoded.push(found?.data ?? '(nothing)');
    }

    for (const pin of pins) {
      expect(decoded.some((d) =>
        d === `${origin}/#/vote/${orgSlug}/${ballotSlug}?pin=${pin}`)).toBe(true);
    }
    await page.emulateMediaType(undefined);
    await page.close();
  });

  test('following such a link opens the ballot already signed in', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });
    await page.goto(`${origin}/#/vote/${orgSlug}/${ballotSlug}?pin=${pins[0]}`,
                    { waitUntil: 'networkidle0' });

    // Straight past the PIN screen and onto the question.
    await waitForText(page, 'Carry the motion');
    expect(await page.$('.pin-entry')).toBeNull();

    // And the PIN is not left in the address bar of a shared phone.
    expect(await page.evaluate(() => window.location.hash)).not.toContain('pin=');
    await page.close();
  });

  test('a link carrying a PIN that is not on the ballot is refused', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/#/vote/${orgSlug}/${ballotSlug}?pin=000000`,
                    { waitUntil: 'networkidle0' });
    await waitForText(page, 'not valid');
    await page.close();
  });
});

test('a link handed out does not carry the privacy page with it', async () => {
  /*
   * The privacy page answers to a real path, served by 404.html. So reaching
   * it and then clicking into the app leaves the address bar reading
   * `/privacy-and-terms-of-service#/manage/<id>`: the fragment moved, the path
   * did not. Every absolute URL the app builds used to start from
   * `location.pathname`, so from that moment the voting link it showed -- and
   * the address encoded into the QR on every printed slip -- pointed at the
   * privacy document.
   */
  const page = await signedInPage();

  const linksFrom = async (start: string, then?: string) => {
    await page.goto(start, { waitUntil: 'networkidle0' });
    if (then) {
      await page.evaluate((h) => { window.location.hash = h; }, then);
      await page.waitForFunction((h) => window.location.hash === h, {}, then);
    }
    await waitForText(page, 'Links');
    await clickByText(page, 'button', 'Links');
    await page.waitForSelector('.share-url', { timeout: 15000 });
    return page.$$eval('.share-url',
      (n) => n.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, '')));
  };

  const direct = await linksFrom(`${origin}/#/manage/${createdBallotId}`);
  const viaDocument = await linksFrom(
    `${origin}/privacy-and-terms-of-service`, `#/manage/${createdBallotId}`);

  // the path really is still the document's -- otherwise this proves nothing
  expect(await page.evaluate(() => window.location.pathname))
    .toBe('/privacy-and-terms-of-service');

  expect(direct.length).toBeGreaterThan(0);
  expect(viaDocument).toEqual(direct);
  for (const url of viaDocument) expect(url).not.toContain('privacy-and-terms-of-service');

  await page.close();
});

test('every slip carries the PIN as a code of its own, whatever the QR is set to', async () => {
  /*
   * The big code points at the ballot, and carries the PIN only when the
   * organizer has asked it to. The barcode always carries the PIN and nothing
   * else, so a hand-held scanner at the door reads the six digits off any slip
   * either way. Decoded with ZXing rather than with our own encoder run
   * backwards, so a wrong pattern table fails here instead of agreeing with
   * itself.
   */
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: b } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('pincode'), title: 'PIN code slips', status: 'draft',
  }).select('id').single();
  const ballot = b!.id;
  const minted = await organizer.rpc('issue_tokens', { p_ballot: ballot, p_count: 3 });
  const pins = (minted.data as Array<{ pin: string }>).map((t) => t.pin);

  const page = await signedInPage();
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 3 });
  await page.goto(`${origin}/#/manage/${ballot}`, { waitUntil: 'networkidle0' });
  await clickByText(page, 'button', 'PINs');
  await page.waitForSelector('table tbody tr', { timeout: 15000 });
  await page.evaluate(() => { window.print = () => {}; });

  const readPinCodes = async () => {
    await page.waitForFunction(
      () => document.querySelectorAll('.slip-pin-code').length === 3, { timeout: 15000 });
    await page.emulateMediaType('print');
    const out: string[] = [];
    for (const code of await page.$$('.slip-pin-code')) {
      const png = PNG.sync.read(Buffer.from(await code.screenshot({ encoding: 'binary' }) as Buffer));
      out.push(await decodeBarcode(png) ?? '(nothing)');
    }
    await page.emulateMediaType(undefined);
    return out;
  };

  // with the setting off, which is how it loads
  await clickByText(page, 'button', 'Print slips');
  expect((await readPinCodes()).sort()).toEqual([...pins].sort());

  // and with it on, when the big code carries the PIN as well
  await clickByText(page, 'label', 'Put the PIN in the code as well');
  expect((await readPinCodes()).sort()).toEqual([...pins].sort());

  // it is the last thing across the slip, and narrow. measured on paper: the
  // sheet is display:none on screen, so every rectangle is zero unless print
  // media is the one in force.
  await page.emulateMediaType('print');
  const geometry = await page.evaluate(() => {
    const slip = document.querySelector('.slip')!;
    const box = (sel: string) => {
      const el = slip.querySelector(sel) as SVGSVGElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: Math.round(r.right), width: r.width, height: r.height };
    };
    return {
      children: [...slip.children].map((c) => c.getAttribute('class') ?? ''),
      qr: box('.slip-qr'), pin: box('.slip-pin-code'),
      slipRight: Math.round(slip.getBoundingClientRect().right),
    };
  });
  await page.emulateMediaType(undefined);

  expect(geometry.children[geometry.children.length - 1]).toContain('slip-pin-code');
  expect(geometry.pin!.right).toBeGreaterThan(geometry.qr!.right);
  // stood on end: the symbol runs down the slip, so it is taller than it is
  // wide, and narrower than the square code -- which is the point of standing
  // it up, since its length is what decides whether it reads
  expect(geometry.pin!.height).toBeGreaterThan(geometry.pin!.width);
  expect(geometry.pin!.width).toBeLessThan(geometry.qr!.width);

  await organizer.from('ballots').delete().eq('id', ballot);
  await page.close();
});
