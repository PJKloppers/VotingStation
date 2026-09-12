/**
 * The camera, with a real code in front of it.
 *
 * Brave is given a fake capture device fed from a video file, and that file is
 * a picture of a code this test encoded with the app's own encoder. So the path
 * under test is the whole one: encode, render, capture, decode, navigate.
 *
 * Needs ffmpeg to build the video. Skips itself if there is none rather than
 * failing on a machine that never had it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import puppeteer, { type Browser } from 'puppeteer-core';
import { encodeQr, QUIET, qrPath } from '../../src/lib/qr';
import { braveExecutable, launchBrave, serveStatic, waitForText } from '../helpers/browser';
import { organizerClient, uniqueSlug } from '../helpers/env';

const DIST = new URL('../../dist', import.meta.url).pathname;
const HAVE_FFMPEG = await Bun.$`which ffmpeg`.quiet().then(() => true).catch(() => false);

let organizer: SupabaseClient;
let origin = '';
let stop: () => void;
let orgSlug = '';
let ballotSlug = '';
let ballotId = '';
let feed = '';

/** A webcam-sized still of a code for `url`, as a y4m video Brave can play. */
async function fakeCamera(url: string, into: string): Promise<void> {
  const code = encodeQr(url);
  if (!code) throw new Error('that url does not fit in a code');
  const span = code.size + QUIET * 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="#b9c4c9"/>
    <svg x="120" y="40" width="400" height="400" viewBox="0 0 ${span} ${span}">
      <rect width="100%" height="100%" fill="#fff"/>
      <path d="${qrPath(code)}" fill="#000"/>
    </svg></svg>`;

  const browser = await launchBrave();
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 480 });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  const png = `${into}.png`;
  await page.screenshot({ path: png as `${string}.png` });
  await browser.close();

  await Bun.$`ffmpeg -y -loglevel error -loop 1 -i ${png} -t 6 -r 10 -pix_fmt yuv420p ${into}`.quiet();
  await rm(png, { force: true });
}

/** Brave, pointed at a file instead of a camera. */
async function browserWatching(file: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: braveExecutable(),
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${file}`,
    ],
  });
}

beforeAll(async () => {
  if (!HAVE_FFMPEG) return;
  if (!(await Bun.file(`${DIST}/index.html`).exists())) {
    throw new Error('No dist/. Run `bun run build` before the browser tests.');
  }

  const served = serveStatic(DIST);
  origin = served.origin;
  stop = () => served.server.stop(true);

  organizer = await organizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id, slug').eq('owner_id', user.user!.id).limit(1).single();
  orgSlug = org!.slug;
  ballotSlug = uniqueSlug('scanned');

  const { data: b } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: ballotSlug, title: 'Scanned Ballot', status: 'live',
  }).select('id').single();
  ballotId = b!.id;

  feed = `${tmpdir()}/votingstation-cam-${Date.now()}.y4m`;
  await fakeCamera(`${origin}/#/vote/${orgSlug}/${ballotSlug}`, feed);
});

afterAll(async () => {
  if (!HAVE_FFMPEG) return;
  if (feed) await rm(feed, { force: true });
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer?.auth.signOut();
  stop?.();
});

describe('the scanner', () => {
  test('there is an ffmpeg to build the fake camera with', () => {
    // Without this the four tests below would return early and read as passes.
    expect(HAVE_FFMPEG).toBe(true);
  });

  test('reads a printed code and opens that ballot', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await browserWatching(feed);
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });

    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Scan the code on your slip');

    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.innerText.includes('Scan a code'))!.click();
    });

    await page.waitForFunction(
      () => window.location.hash.startsWith('#/vote/'), { timeout: 30000 });
    expect(await page.evaluate(() => window.location.hash))
      .toBe(`#/vote/${orgSlug}/${ballotSlug}`);

    // And it is the ballot, asking for a PIN.
    await page.waitForSelector('.pin-entry', { timeout: 15000 });
    await waitForText(page, 'Scanned Ballot');

    await browser.close();
  });

  test('the camera and its decoder are not in the first load', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await browserWatching(feed);
    const page = await browser.newPage();
    const scripts: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('.js')) scripts.push(r.url()); });

    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await waitForText(page, 'Scan the code on your slip');
    const before = scripts.length;

    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.innerText.includes('Scan a code'))!.click();
    });
    await page.waitForFunction(
      () => window.location.hash.startsWith('#/vote/'), { timeout: 30000 });

    // Pressing the button is what fetches them.
    expect(scripts.length).toBeGreaterThan(before);
    await browser.close();
  });

  test('typing the line under the code works without a camera at all', async () => {
    if (!HAVE_FFMPEG) return;
    // No fake device: getUserMedia has nothing to give, which is the point.
    const browser = await launchBrave();
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });

    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="ballot_link"]', { timeout: 15000 });
    await page.type('input[name="ballot_link"]', `${orgSlug}/${ballotSlug}`);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.innerText.includes('Open that ballot'))!.click();
    });

    await page.waitForSelector('.pin-entry', { timeout: 15000 });
    await waitForText(page, 'Scanned Ballot');
    await browser.close();
  });

  test('a link that is not one of ours is refused, not followed', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await launchBrave();
    const page = await browser.newPage();
    await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('input[name="ballot_link"]', { timeout: 15000 });
    await page.type('input[name="ballot_link"]', 'https://example.com/somewhere');
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => b.innerText.includes('Open that ballot'))!.click();
    });
    await waitForText(page, 'does not look like a ballot link');
    expect(await page.evaluate(() => window.location.hash)).toBe('#/');
    await browser.close();
  });
});
