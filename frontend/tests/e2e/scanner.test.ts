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
import { barcodePath, encodeBarcode } from '../../src/lib/barcode';
import { braveExecutable, clickByText, launchBrave, serveStatic, waitForText } from '../helpers/browser';
import { credentials, organizerClient, uniqueSlug } from '../helpers/env';

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

  const png = `${into}.png`;
  const browser = await launchBrave();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 480 });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: png as `${string}.png` });
  } finally {
    await browser.close();
  }

  await Bun.$`ffmpeg -y -loglevel error -loop 1 -i ${png} -t 6 -r 10 -pix_fmt yuv420p ${into}`.quiet();
  await rm(png, { force: true });
}

/** The same, showing a PIN's barcode rather than a ballot's QR. */
async function fakeBarcodeCamera(pin: string, into: string): Promise<void> {
  const code = encodeBarcode(pin);
  if (!code) throw new Error('that pin does not encode');

  // A slip, as a camera held over one actually sees it: white paper filling the
  // frame, the barcode standing up its right-hand edge as printed, and the rest of the slip's printing there
  // too so the decoder has to pick it out of something rather than out of an
  // empty field.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="640" height="480" fill="#fff"/>
    <text x="40" y="90" font-family="Georgia,serif" font-size="30" fill="#000">Annual general meeting</text>
    <text x="40" y="150" font-family="monospace" font-size="46" fill="#000">${pin}</text>
    <svg x="430" y="40" width="120" height="400" viewBox="0 0 26 ${code.width}"
         preserveAspectRatio="none" shape-rendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff"/>
      <g transform="translate(26 0) rotate(90)">
        <path d="${barcodePath(code, 26)}" fill="#000"/>
      </g>
    </svg></svg>`;

  const png = `${into}.png`;
  const browser = await launchBrave();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 480 });
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.screenshot({ path: png as `${string}.png` });
  } finally {
    await browser.close();
  }

  await Bun.$`ffmpeg -y -loglevel error -loop 1 -i ${png} -t 8 -r 10 -pix_fmt yuv420p ${into}`.quiet();
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
    try {
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

    } finally {
      await browser.close();
    }
  });

  test('the camera and its decoder are not in the first load', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await browserWatching(feed);
    try {
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
    } finally {
      await browser.close();
    }
  });

  test('typing the line under the code works without a camera at all', async () => {
    if (!HAVE_FFMPEG) return;
    // No fake device: getUserMedia has nothing to give, which is the point.
    const browser = await launchBrave();
    try {
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
    } finally {
      await browser.close();
    }
  });

  test('a link that is not one of ours is refused, not followed', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await launchBrave();
    try {
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
    } finally {
      await browser.close();
    }
  });
});

describe('scanning a slip to take its PIN off the roll', () => {
  /*
   * The desk case: a slip comes back and the person holding it should not have
   * to find six digits in a table of two thousand. The barcode is read, the PIN
   * it names is deleted, and the votes cast with it go too -- which is the part
   * worth checking against the database rather than against the screen.
   */
  let ballot = '';
  let pin = '';
  let camera = '';

  beforeAll(async () => {
    if (!HAVE_FFMPEG) return;
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    const { data: b } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('scandel'), title: 'Scan to delete',
      status: 'live', mode: 'open',
    }).select('id').single();
    ballot = b!.id;

    const { data: q } = await organizer.from('questions_yes_no').insert({
      ballot_id: ballot, prompt: 'Carry the motion', sort_order: 1, gate_open: true,
    }).select('id').single();

    const minted = await organizer.rpc('issue_tokens', { p_ballot: ballot, p_count: 2 });
    pin = (minted.data as Array<{ pin: string }>)[0]!.pin;

    // it votes, so there is something to take with it
    await organizer.rpc('cast_yes_no', {
      p_ballot: ballot, p_pin: pin, p_question: q!.id,
      p_choice: 'yes', p_fingerprint: 'fp-scandel',
    });

    camera = `${tmpdir()}/votingstation-bar-${Date.now()}.y4m`;
    await fakeBarcodeCamera(pin, camera);
  });

  afterAll(async () => {
    if (!HAVE_FFMPEG) return;
    if (camera) await rm(camera, { force: true });
    if (ballot) await organizer.from('ballots').delete().eq('id', ballot);
  });

  test('the barcode is read, and the PIN and its votes go', async () => {
    if (!HAVE_FFMPEG) return;

    const votesBefore = await organizer.from('votes_yes_no')
      .select('id', { count: 'exact', head: true }).eq('ballot_id', ballot);
    expect(votesBefore.count).toBe(1);

    const browser = await browserWatching(camera);
    try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1000 });

    const { email, password } = credentials();
    await page.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await page.type('input[type=email]', email);
    await page.type('input[type=password]', password);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((b) => (b as HTMLButtonElement).type === 'submit')!.click();
    });
    await page.waitForFunction(() => window.location.hash.startsWith('#/admin'), { timeout: 30000 });

    await page.goto(`${origin}/#/manage/${ballot}`, { waitUntil: 'networkidle0' });
    await clickByText(page, 'button', 'PINs');
    await page.waitForSelector('table tbody tr', { timeout: 20000 });
    await clickByText(page, 'button', 'Scan to delete');

    // the camera finds it and stops to ask, with the vote count in the question
    await page.waitForSelector('.scan-ask', { timeout: 40000 });
    expect(await page.$eval('.scan-ask .pin-display', (n) => (n as HTMLElement).innerText.trim()))
      .toBe(pin);
    await waitForText(page, '1 vote will be deleted with it');

    await page.evaluate(() => {
      ([...document.querySelectorAll('.scan-ask button')] as HTMLButtonElement[])
        .find((b) => b.innerText.trim() === 'Delete it')!.click();
    });
    await waitForText(page, `${pin} deleted`);

    // the database, not the screen
    const { data: left } = await organizer.from('ballot_tokens')
      .select('pin').eq('ballot_id', ballot);
    expect(left!.map((t) => t.pin)).not.toContain(pin);
    expect(left).toHaveLength(1);

    const votesAfter = await organizer.from('votes_yes_no')
      .select('id', { count: 'exact', head: true }).eq('ballot_id', ballot);
    expect(votesAfter.count).toBe(0);

    } finally {
      await browser.close();
    }
  }, 90000);
});

describe('a voter reading their own PIN off the slip', () => {
  /*
   * The other side of the same camera: not the desk taking a PIN off the roll,
   * but the person holding the slip, who would otherwise be typing six digits
   * off a small line of print while standing up in a hall.
   */
  let ballot = '';
  let pin = '';
  let camera = '';

  beforeAll(async () => {
    if (!HAVE_FFMPEG) return;
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();
    const { data: b } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('scanpin'), title: 'Scanned In',
      status: 'live', mode: 'open',
    }).select('id').single();
    ballot = b!.id;

    await organizer.from('questions_yes_no').insert({
      ballot_id: ballot, prompt: 'Carry the motion', sort_order: 1, gate_open: true,
    });

    const minted = await organizer.rpc('issue_tokens', { p_ballot: ballot, p_count: 1 });
    pin = (minted.data as Array<{ pin: string }>)[0]!.pin;

    camera = `${tmpdir()}/votingstation-voterbar-${Date.now()}.y4m`;
    await fakeBarcodeCamera(pin, camera);
  });

  afterAll(async () => {
    if (!HAVE_FFMPEG) return;
    if (camera) await rm(camera, { force: true });
    if (ballot) await organizer.from('ballots').delete().eq('id', ballot);
  });

  test('scans the barcode and is let onto the floor', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await browserWatching(camera);
    try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900 });

    await page.goto(`${origin}/#/vote/${ballot}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.pin-entry', { timeout: 15000 });

    // typing is still the first thing offered; scanning is the other way
    await clickByText(page, 'button', 'Scan my slip instead');
    await waitForText(page, 'Carry the motion', 40000);

    // it went in on the scanned PIN, and the digits are not left on the screen
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain(pin);
    expect(await page.$('.pin-entry')).toBeNull();

    } finally {
      await browser.close();
    }
  }, 90000);

  test('the camera and its decoders are not in the first load', async () => {
    if (!HAVE_FFMPEG) return;
    const browser = await browserWatching(camera);
    try {
    const page = await browser.newPage();
    const scripts: string[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('.js')) scripts.push(r.url());
    });

    await page.goto(`${origin}/#/vote/${ballot}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.pin-entry', { timeout: 15000 });

    const weight = async (urls: string[]) => {
      let total = 0;
      for (const u of urls) total += (await (await fetch(u)).text()).length;
      return total;
    };
    const beforeBytes = await weight(scripts);

    await clickByText(page, 'button', 'Scan my slip instead');
    await waitForText(page, 'Carry the motion', 40000);

    // the decoders are several hundred kB; a PIN screen must not carry them
    const afterBytes = await weight(scripts);
    expect(afterBytes - beforeBytes).toBeGreaterThan(200_000);

    } finally {
      await browser.close();
    }
  }, 90000);
});
