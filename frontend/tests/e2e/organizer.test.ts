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
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Browser, Page } from 'puppeteer-core';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { clickByText, clickWithin, launchBrave, serveStatic, waitForText } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;

let browser: Browser;
let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let orgName: string;
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
    .select('id, name').eq('owner_id', user.user!.id).limit(1).maybeSingle();

  orgName = org?.name ?? (await organizer.from('organizations')
    .insert({ owner_id: user.user!.id, slug: uniqueSlug('e2e-org'), name: 'E2E Org' })
    .select('name').single()).data!.name;

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

  test('publishing it puts the organization in the public directory', async () => {
    const page = await signedInPage();
    await page.goto(`${origin}/#/manage/${createdBallotId}`, { waitUntil: 'networkidle0' });
    await waitForText(page, title);

    await clickByText(page, 'button', 'Publish');
    await page.waitForSelector('.pill.live', { timeout: 15000 });

    // The front page lists organizations; the ballots arrive when one is opened.
    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await waitForText(page, orgName);

    const before = await page.evaluate(() => document.body.innerText);
    expect(before).not.toContain(title);

    await clickByText(page, 'button', orgName);
    await waitForText(page, title);

    await page.close();
  });
});
