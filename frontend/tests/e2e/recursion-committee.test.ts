/**
 * A committee of four and a chairperson, run in parallel from the chair's
 * Live tab, to a full committee and a winner.
 *
 * Both races are "Narrow it down" from the same pool; the committee has four
 * seats, the chair one. Twenty voters: five people at a phone (each a Brave
 * profile of their own, at human pace) and fifteen anonymous voters casting
 * straight to the database at random moments. A sixth profile is the chair.
 *
 * What it proves, in the browser:
 *   - each race moves on its own gate, with both open at once;
 *   - the chair's panel stays simple: one main button per stage, the rest
 *     folded under "More controls";
 *   - settling asks how people drop out, every round, with a live preview,
 *     and refuses an answer that would leave fewer people than seats;
 *   - a tie on the last seat is broken in the same dialog;
 *   - the voter sees "2 seats open · choose up to 2", never someone elected;
 *   - nobody but the ballot's owner reaches the controls.
 *
 *   Committee, 4 seats, 20 voters (a majority is 11 or more)
 *     Nominations  Ada 12, Ben 11, Cleo 10, Dev 9, Eli 8, Fay 7, Gus 5, Hal 1
 *                  → 7 through (2 needed)
 *     Round 1      4 open: Ada 15, Ben 12 elected. "8 or fewer" is refused
 *                  (it would leave 1 for 2 seats); "3 or fewer" drops Fay, Gus.
 *     Round 2      2 open: Cleo 14, Dev 13, Eli 13 all have a majority; Cleo
 *                  is in, the last seat is a tie: the chair elects Dev.
 *
 *   Chairperson, 1 seat
 *     Nominations  Ada 6, Ben 6, Cleo 4, Dev 4
 *     Round 1      Ada 8, Ben 6, Cleo 4, Dev 2; the lowest 2 drop
 *     Round 2      Ada 11 of 20: a majority, so she wins
 *
 * Run `bun run build` first. HEADED=1 watches it; SEED=n replays the timing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, credentials, organizerClient, uniqueSlug } from '../helpers/env';
import { braveExecutable, serveStatic } from '../helpers/browser';

const DIST = new URL('../../dist', import.meta.url).pathname;
const COMMITTEE = 'Committee';
const CHAIR = 'Chairperson';
const POOL = ['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hal', 'Ida'];
const VOTERS = 20;

/* ------------------------------------------------------------ the scripts */

/**
 * Twenty ballots that produce exactly these counts, none over `max`: each
 * person's votes go to whoever holds the fewest picks so far.
 */
function ballotsFor(counts: Record<string, number>, max: number): string[][] {
  const ballots: string[][] = Array.from({ length: VOTERS }, () => []);
  for (const [label, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const takers = ballots.map((b, i) => ({ i, n: b.length }))
      .sort((a, b) => a.n - b.n || a.i - b.i).slice(0, n);
    for (const t of takers) ballots[t.i]!.push(label);
  }
  if (ballots.some((b) => b.length > max || b.length === 0)) throw new Error('script does not fit');
  return ballots;
}

const S = {
  committeeNoms: ballotsFor({ Ada: 12, Ben: 11, Cleo: 10, Dev: 9, Eli: 8, Fay: 7, Gus: 5, Hal: 1 }, 4),
  committeeR1: ballotsFor({ Ada: 15, Ben: 12, Cleo: 9, Dev: 8, Eli: 6, Fay: 3, Gus: 2 }, 4),
  committeeR2: ballotsFor({ Cleo: 14, Dev: 13, Eli: 13 }, 2),
  chairNoms: ballotsFor({ Ada: 6, Ben: 6, Cleo: 4, Dev: 4 }, 1),
  chairR1: ballotsFor({ Ada: 8, Ben: 6, Cleo: 4, Dev: 2 }, 1),
  chairR2: ballotsFor({ Ada: 11, Ben: 9 }, 1),
};

/* ------------------------------------------------------------ human timing */

let seed = Number(process.env.SEED ?? Date.now() % 100000);
const SEED = seed;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, between(min, max)));

/* ---------------------------------------------------------------- the room */

interface Phone { n: number; pin: string; browser: Browser; page: Page }

let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let poolId = '';
let ballotId = '';
const qid: Record<string, string> = {};
const opt: Record<string, Record<string, string>> = {};
let pins: string[] = [];
const phones: Phone[] = [];
let chairBrowser: Browser;
let chair: Page;
const dirs: string[] = [];
const pageErrors: string[] = [];
const log: string[] = [];
const note = (s: string) => { log.push(`${new Date().toISOString().slice(11, 23)} ${s}`); };

async function braveProfile(label: string): Promise<Browser> {
  const dir = await mkdtemp(join(tmpdir(), `vs-${label}-`));
  dirs.push(dir);
  return puppeteer.launch({
    executablePath: braveExecutable(),
    headless: process.env.HEADED !== '1',
    userDataDir: dir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-brave-update',
      '--no-first-run', '--no-default-browser-check'],
  });
}

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
    .select('id').eq('owner_id', user.user!.id).limit(1).single();

  const { data: pool } = await organizer.from('option_pools')
    .insert({ org_id: org!.id, name: `Members ${Date.now().toString(36)}` }).select('id').single();
  poolId = pool!.id;
  await organizer.from('option_pool_entries')
    .insert(POOL.map((label, i) => ({ pool_id: poolId, label, sort_order: i })));

  const { data: ballot, error } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('e2e-committee'), title: 'Committee Elections',
    status: 'live', mode: 'gated', allow_vote_change: true, results_public: true, show_results_after: true,
  }).select('id').single();
  if (error) throw new Error(error.message);
  ballotId = ballot!.id;

  for (const [prompt, seats, nominate_max, nominate_threshold, order] of
    [[COMMITTEE, 4, 4, 2, 1], [CHAIR, 1, 1, 1, 2]] as const) {
    const { data: q, error: qe } = await organizer.from('questions_recursion_filter').insert({
      ballot_id: ballotId, prompt, seats, nominate_max, nominate_threshold, sort_order: order,
      stop_on_majority: true, pick_min: 1, pick_max: seats,
    }).select('id').single();
    if (qe) throw new Error(qe.message);
    qid[prompt] = q!.id;
    await organizer.rpc('copy_pool_into_question', { p_pool: poolId, p_type: 'recursion_filter', p_question: q!.id });
    const { data: os } = await organizer.from('options_recursion_filter').select('id, label').eq('question_id', q!.id);
    opt[prompt] = Object.fromEntries((os ?? []).map((o) => [o.label, o.id]));
  }

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: VOTERS });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);

  chairBrowser = await braveProfile('chair');
  chair = await chairBrowser.newPage();
  await chair.setViewport({ width: 1180, height: 1000 });
  chair.on('pageerror', (e) => pageErrors.push(`chair: ${e}`));
  chair.on('dialog', (d) => { void d.accept(); });

  await Promise.all([0, 1, 2, 3, 4].map(async (n) => {
    const browser = await braveProfile(`p${n + 1}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => pageErrors.push(`P${n + 1}: ${e}`));
    phones.push({ n, pin: pins[n]!, browser, page });
  }));
  phones.sort((a, b) => a.n - b.n);
  note(`seed ${SEED}; ballot ${ballotId}`);
}, 120000);

afterAll(async () => {
  await Promise.all([chairBrowser, ...phones.map((p) => p.browser)].map((b) => b?.close()));
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  if (poolId) await organizer.from('option_pools').delete().eq('id', poolId);
  await organizer.auth.signOut();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  const file = join(tmpdir(), `vs-committee-${SEED}.log`);
  await Bun.write(file, log.join('\n'));
  console.log(`committee log: ${file}`);
});

/* ------------------------------------------------------- the database's view */

async function race(prompt: string) {
  const { data } = await organizer.from('questions_recursion_filter')
    .select('phase, current_round, gate_open, winner_id').eq('id', qid[prompt]!).single();
  return data!;
}

async function seated(prompt: string): Promise<string[]> {
  const { data } = await organizer.from('options_recursion_filter')
    .select('label').eq('question_id', qid[prompt]!).eq('status', 'elected').order('seat_no');
  return (data ?? []).map((o) => o.label);
}

/* ------------------------------------------------------------- the voters */

/** The fifteen anonymous voters, each at a moment of their own. */
const anonRoom = (prompt: string, script: string[][]) =>
  Promise.all(script.slice(5).map(async (labels, i) => {
    await pause(200, 3500);
    const { data, error } = await anonClient().rpc('cast_recursion_filter', {
      p_ballot: ballotId, p_pin: pins[i + 5], p_question: qid[prompt],
      p_options: labels.map((l) => opt[prompt]![l]), p_abstain: false, p_fingerprint: null,
    });
    if (error || !(data as { ok: boolean }).ok) throw new Error(`A${i + 1} on ${prompt}: ${error?.message ?? JSON.stringify(data)}`);
  }));

async function ballotCard(page: Page, prompt: string, stage: string, timeout = 30000) {
  const find = (needChoices: boolean) => page.waitForFunction((p: string, st: string, need: boolean) =>
    [...document.querySelectorAll('[data-question-card]')].find((c) =>
      (c.querySelector('h2') as HTMLElement | null)?.innerText.trim() === p
      && (c.querySelector('.eyebrow') as HTMLElement | null)?.innerText.trim().toLowerCase() === st.toLowerCase()
      && (!need || c.querySelector('.choice'))) ?? false,
  { timeout, polling: 250 }, prompt, stage, needChoices);
  const card = (await find(false)).asElement() as ElementHandle<Element>;
  // folded (several questions open, or already answered): open it, as a person would
  if (!(await card.$('.choice'))) {
    const opener = await card.$$('button');
    for (const b of opener) {
      const t = await b.evaluate((e) => (e as HTMLElement).innerText.trim());
      if (t === 'Vote' || t === 'Change my vote') {
        await pause(300, 900);
        await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await b.click();
        break;
      }
    }
  }
  return (await find(true)).asElement() as ElementHandle<Element>;
}

const labelsIn = (card: ElementHandle<Element>) =>
  card.$$eval('.choice', (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());

/** Taps a name, and checks the tap took (scrolling it clear of the top bar). */
async function tap(card: ElementHandle<Element>, label: string) {
  for (const b of await card.$$('.choice')) {
    if ((await b.evaluate((e) => (e as HTMLElement).innerText.replace('✓', '').trim())) !== label) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await b.evaluate((e) => e.getAttribute('aria-pressed'));
      await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await pause(120, 300);
      await b.click();
      await pause(150, 250);
      if ((await b.evaluate((e) => e.getAttribute('aria-pressed'))) !== before) return;
    }
    throw new Error(`Tapping ${label} never took.`);
  }
  throw new Error(`No choice "${label}" on the card.`);
}

async function humanVote(p: Phone, prompt: string, stage: string, labels: string[], expectOn?: string[]) {
  const card = await ballotCard(p.page, prompt, stage);
  if (expectOn) expect(await labelsIn(card)).toEqual([...expectOn].sort());
  await pause(800, 3000);                                    // reading
  for (const l of labels) { await tap(card, l); await pause(300, 1200); }
  const picked = await card.$$eval('.choice[aria-pressed="true"]',
    (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());
  expect(picked).toEqual([...labels].sort());
  await pause(400, 1500);
  const send = (await card.$$('button.primary')).pop()!;
  await send.click();
  await p.page.waitForFunction((pr: string, st: string) =>
    [...document.querySelectorAll('.card')].some((c) =>
      (c.querySelector('h2') as HTMLElement | null)?.innerText.trim() === pr
      && (c.querySelector('.eyebrow') as HTMLElement | null)?.innerText.trim().toLowerCase() === st.toLowerCase()
      && (c as HTMLElement).innerText.includes('Your answer is recorded')),
  { timeout: 15000, polling: 200 }, prompt, stage);
  note(`P${p.n + 1} → ${prompt} ${stage}: ${labels.join(', ')}`);
}

/** The five phones and the fifteen anon voters, all on one round at once. */
const roomVotes = (prompt: string, stage: string, script: string[][], expectOn?: string[]) =>
  Promise.all([
    ...phones.map((p) => humanVote(p, prompt, stage, script[p.n]!, expectOn)),
    anonRoom(prompt, script),
  ]);

/** Waits until every phone shows exactly these cards to vote on. */
async function phonesShow(cards: string[]) {
  const want = cards.map((c) => c.toLowerCase()).sort();
  await Promise.all(phones.map((p) => p.page.waitForFunction((w: string[]) => {
    const got = [...document.querySelectorAll('.card')]
      .filter((c) => c.hasAttribute('data-question-card'))
      .map((c) => `${(c.querySelector('h2') as HTMLElement).innerText.trim()}|${(c.querySelector('.eyebrow') as HTMLElement).innerText.trim()}`.toLowerCase())
      .sort();
    return JSON.stringify(got) === JSON.stringify(w);
  }, { timeout: 30000, polling: 300 }, want)));
}

/* ---------------------------------------------------------------- the chair */

async function raceCard(prompt: string) {
  const handle = await chair.waitForFunction((p: string) =>
    [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p) ?? false,
  { timeout: 15000, polling: 250 }, prompt);
  return handle.asElement() as ElementHandle<Element>;
}

/** Presses a button on one race's card (outside the dialog), exactly by label. */
async function press(prompt: string, label: string) {
  await pause(400, 1200);
  const handle = await chair.waitForFunction((p: string, l: string) => {
    const card = [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p);
    return card ? [...card.querySelectorAll('button')].find((b) =>
      !b.closest('dialog') && (b as HTMLElement).innerText.trim() === l && !(b as HTMLButtonElement).disabled) ?? false : false;
  }, { timeout: 20000, polling: 250 }, prompt, label);
  await (handle.asElement() as ElementHandle<Element>).click();
  note(`chair presses "${label}" on ${prompt}`);
}

async function chairSees(prompt: string, text: string, timeout = 20000) {
  await chair.waitForFunction((p: string, t: string) => {
    const card = [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p);
    return !!card && (card as HTMLElement).innerText.toLowerCase().includes(t.toLowerCase());
  }, { timeout, polling: 250 }, prompt, text).catch(async () => {
    const shown = await (await raceCard(prompt)).evaluate((e) => (e as HTMLElement).innerText);
    throw new Error(`Chair's "${prompt}" card never showed "${text}". It reads:\n${shown}`);
  });
}

/** Types into the seats question on a race's card. */
async function typeSeats(prompt: string, n: number) {
  const input = (await (await raceCard(prompt)).$('input[name="confirm_seats"]'))!;
  await input.click();
  await input.evaluate((e) => { (e as HTMLInputElement).select(); });
  await input.type(String(n), { delay: between(80, 200) });
  await pause(300, 800);
}

const dialogText = () => chair.evaluate(() => (document.querySelector('dialog[open]') as HTMLElement | null)?.innerText ?? '');

async function dialogSays(text: string) {
  await chair.waitForFunction((t: string) =>
    ((document.querySelector('dialog[open]') as HTMLElement | null)?.innerText ?? '').toLowerCase().includes(t.toLowerCase()),
  { timeout: 10000, polling: 200 }, text).catch(async () => {
    throw new Error(`The settle dialog never showed "${text}". It reads:\n${await dialogText()}`);
  });
}

/** Answers the drop-off question in the open dialog. */
async function answer(rule: 'votes' | 'count' | 'none', n: number | null = null) {
  const dialog = (await chair.waitForSelector('dialog[open]', { timeout: 10000 }))!;
  if (rule === 'none') {
    await (await dialog.$('input[name="drop_rule"][value="none"]'))!.click();
  } else {
    const input = (await dialog.$(`input[name="drop_${rule === 'votes' ? 'votes' : 'count'}"]`))!;
    await input.click();
    await input.evaluate((e) => { (e as HTMLInputElement).select(); });
    await input.type(String(n), { delay: between(80, 200) });
  }
  await pause(400, 900);
  note(`chair answers: ${rule} ${n ?? ''}`);
}

async function tick(name: 'seat_tie' | 'cut_tie', label: string) {
  const dialog = (await chair.waitForSelector('dialog[open]'))!;
  for (const b of await dialog.$$(`label.check:has(input[name="${name}"])`)) {
    if ((await b.evaluate((e) => (e as HTMLElement).innerText.trim())) === label) { await b.click(); return; }
  }
  throw new Error(`No ${name} box for ${label}.`);
}

const settleButton = () => chair.evaluateHandle(() =>
  [...document.querySelectorAll('dialog[open] button')].find((b) =>
    (b as HTMLElement).innerText.trim().startsWith('Settle round')) ?? null);

async function confirmSettle() {
  const b = (await settleButton()).asElement() as ElementHandle<HTMLButtonElement>;
  expect(await b.evaluate((e) => e.disabled)).toBe(false);
  await b.click();
  await chair.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 15000 });
}

/** Buttons the chair sees on a race's card, outside the folded controls and any dialog. */
const visibleButtons = async (prompt: string) =>
  (await raceCard(prompt)).$$eval('button', (bs) => bs
    .filter((b) => !b.closest('details') && !b.closest('dialog') && (b as HTMLElement).offsetParent !== null)
    .map((b) => (b as HTMLElement).innerText.trim()));

/* ======================================================================== */

describe('a committee and a chairperson, side by side, to the end', () => {
  test('the chair signs in; both races wait at nominations with one button each', async () => {
    const { email, password } = credentials();
    await chair.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="email"]', { timeout: 15000 });
    await chair.type('input[name="email"]', email, { delay: 30 });
    await chair.type('input[name="password"]', password, { delay: 30 });
    await chair.keyboard.press('Enter');
    await chair.waitForFunction(() => document.body.innerText.includes('Your ballots'), { timeout: 20000 });
    await chair.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });

    await chairSees(COMMITTEE, '0 of 4 seats filled');
    expect(await visibleButtons(COMMITTEE)).toEqual(['Open nominations']);
    expect(await visibleButtons(CHAIR)).toEqual(['Open nominations']);
    // the rest is folded away until wanted
    const folded = await (await raceCard(COMMITTEE)).$eval('details.more-controls', (d) => (d as HTMLDetailsElement).open);
    expect(folded).toBe(false);
  }, 60000);

  test('people arrive; both nominations open at once and reach every phone', async () => {
    await Promise.all(phones.map(async (p) => {
      await pause(200, 3000);
      await p.page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
      await p.page.waitForSelector('.pin-entry', { timeout: 15000 });
      await pause(500, 1800);
      await p.page.type('.pin-entry', p.pin, { delay: between(90, 250) });
      await p.page.click('button[type="submit"]');
    }));
    await press(COMMITTEE, 'Open nominations');
    await press(CHAIR, 'Open nominations');
    await phonesShow([`${COMMITTEE}|nominations`, `${CHAIR}|nominations`]);
    const card = await ballotCard(phones[0]!.page, COMMITTEE, 'Nominations');
    expect(await card.evaluate((e) => (e as HTMLElement).innerText)).toContain('Nominate up to 4 people');
  }, 90000);

  test('the room nominates for both', async () => {
    await Promise.all([
      ...phones.map(async (p) => {
        await humanVote(p, COMMITTEE, 'Nominations', S.committeeNoms[p.n]!);
        await humanVote(p, CHAIR, 'Nominations', S.chairNoms[p.n]!);
      }),
      anonRoom(COMMITTEE, S.committeeNoms),
      anonRoom(CHAIR, S.chairNoms),
    ]);
  }, 180000);

  test('both nominations close and settle; round 1 of each opens', async () => {
    await press(COMMITTEE, 'Close nominations');
    await press(CHAIR, 'Close nominations');
    await chairSees(COMMITTEE, 'Closed — settle it');
    expect(await visibleButtons(COMMITTEE)).toEqual(['Settle nominations', 'Reopen']);
    await press(COMMITTEE, 'Settle nominations');

    // before round 1 the chair is asked how many seats; nothing else to press
    await chairSees(COMMITTEE, 'How many seats are being filled?');
    expect(await visibleButtons(COMMITTEE)).toEqual(['Confirm 4 seats']);
    await typeSeats(COMMITTEE, 3);
    await chairSees(COMMITTEE, '7 on the shortlist. Each voter will have up to 3 votes in round 1');
    await typeSeats(COMMITTEE, 7);
    await chairSees(COMMITTEE, 'there is nothing to vote on');
    await typeSeats(COMMITTEE, 4);
    await press(COMMITTEE, 'Confirm 4 seats');
    await chairSees(COMMITTEE, '4 seats to fill');
    await chairSees(COMMITTEE, '7 in this round');
    expect(await visibleButtons(COMMITTEE)).toEqual(['Change', 'Open round 1']);

    await press(CHAIR, 'Settle nominations');
    await chairSees(CHAIR, 'One seat: a single winner from 4 on the shortlist');
    await press(CHAIR, 'Confirm 1 seat');
    await chairSees(CHAIR, '4 in this round');

    await press(COMMITTEE, 'Open round 1');
    await press(CHAIR, 'Open round 1');
    await phonesShow([`${COMMITTEE}|round 1`, `${CHAIR}|round 1`]);
    const card = await ballotCard(phones[1]!.page, COMMITTEE, 'Round 1');
    expect(await card.evaluate((e) => (e as HTMLElement).innerText)).toContain('4 seats open · choose up to 4');
  }, 90000);

  test('round 1 of both, voted at once', async () => {
    await Promise.all([
      ...phones.map(async (p) => {
        const order = rand() < 0.5 ? [COMMITTEE, CHAIR] : [CHAIR, COMMITTEE];
        for (const prompt of order) {
          await humanVote(p, prompt, 'Round 1', (prompt === COMMITTEE ? S.committeeR1 : S.chairR1)[p.n]!,
            prompt === COMMITTEE ? ['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus'] : ['Ada', 'Ben', 'Cleo', 'Dev']);
        }
      }),
      anonRoom(COMMITTEE, S.committeeR1),
      anonRoom(CHAIR, S.chairR1),
    ]);
  }, 180000);

  test('committee round 1: the dialog refuses a cut too deep, then two are elected', async () => {
    await press(COMMITTEE, 'Close round 1');
    await chairSees(COMMITTEE, 'Closed — settle it');
    await press(COMMITTEE, 'Settle round 1…');
    await dialogSays('How do people drop out of round 1?');
    await dialogSays('Ada — elected');
    await dialogSays('Ben — elected');

    await answer('votes', 8);
    await dialogSays('leaves 1 for 2 seats');
    const blocked = (await settleButton()).asElement() as ElementHandle<HTMLButtonElement>;
    expect(await blocked.evaluate((e) => e.disabled)).toBe(true);

    await answer('votes', 3);
    await dialogSays('2 drop · 3 stay for 2 seats');
    await dialogSays('Fay — drops');
    await dialogSays('Gus — drops');
    await confirmSettle();

    await chairSees(COMMITTEE, '2 of 4 seats filled');
    await chairSees(COMMITTEE, 'Ada, Ben');
    expect(await seated(COMMITTEE)).toEqual(['Ada', 'Ben']);
  }, 90000);

  test('committee round 2 opens while the chairperson\'s round 1 is still open', async () => {
    await press(COMMITTEE, 'Open round 2');
    await phonesShow([`${COMMITTEE}|round 2`, `${CHAIR}|round 1`]);
    const card = await ballotCard(phones[2]!.page, COMMITTEE, 'Round 2');
    expect(await card.evaluate((e) => (e as HTMLElement).innerText)).toContain('2 seats open · choose up to 2');
    // nobody elected is on the list
    expect(await labelsIn(card)).toEqual(['Cleo', 'Dev', 'Eli']);
    await roomVotes(COMMITTEE, 'Round 2', S.committeeR2, ['Cleo', 'Dev', 'Eli']);
  }, 180000);

  test('chairperson round 1: the lowest two drop; round 2 is voted', async () => {
    await press(CHAIR, 'Close round 1');
    await chairSees(CHAIR, 'Closed — settle it');
    await press(CHAIR, 'Settle round 1…');
    await answer('count', 2);
    await dialogSays('2 drop · 2 stay for 1 seat');
    await confirmSettle();
    await press(CHAIR, 'Open round 2');
    await phonesShow([`${COMMITTEE}|round 2`, `${CHAIR}|round 2`]);
    await roomVotes(CHAIR, 'Round 2', S.chairR2, ['Ada', 'Ben']);
  }, 180000);

  test('committee round 2: three majorities for two seats; the chair breaks the tie on the last', async () => {
    await press(COMMITTEE, 'Close round 2');
    await chairSees(COMMITTEE, 'Closed — settle it');
    await press(COMMITTEE, 'Settle round 2…');
    await dialogSays('Cleo — elected');
    await dialogSays('Choose 1 to elect');
    await dialogSays('Dev — tied for the last seat');
    await dialogSays('Eli — tied for the last seat');
    await pause(800, 2000);
    await tick('seat_tie', 'Dev');
    await dialogSays('fills the last seats');
    await confirmSettle();

    await chairSees(COMMITTEE, '4 of 4 elected');
    expect(await seated(COMMITTEE)).toEqual(['Ada', 'Ben', 'Cleo', 'Dev']);
    expect((await race(COMMITTEE)).phase).toBe('decided');
    await phonesShow([`${CHAIR}|round 2`]);
  }, 90000);

  test('chairperson round 2: Ada has 11 of 20 and wins', async () => {
    await press(CHAIR, 'Close round 2');
    await press(CHAIR, 'Settle round 2…');
    await dialogSays('This round decides the winner');
    await confirmSettle();
    await chairSees(CHAIR, 'Won: Ada');
    expect((await race(CHAIR)).winner_id).toBe(opt[CHAIR]!.Ada!);
    await phonesShow([]);
  }, 60000);

  test('the public results list the committee in seat order', async () => {
    const page = phones[3]!.page;
    await page.goto(`${origin}/#/results/${ballotId}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('ol.committee'), { timeout: 20000 });
    const committee = await page.$$eval('ol.committee li strong', (n) => n.map((e) => (e as HTMLElement).innerText));
    expect(committee).toEqual(['Ada', 'Ben', 'Cleo', 'Dev']);
    // the rounds are folded away; their notes are in the page all the same
    const text = await page.evaluate(() => document.body.textContent ?? '');
    expect(text).toContain('everyone on 3 votes or fewer dropped');
    expect(text).toContain('tie for the last seat broken by the chair');
  }, 60000);

  test('a voter\'s browser cannot reach the chair\'s controls', async () => {
    const page = phones[4]!.page;
    await page.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });
    await pause(2500, 3000);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('More controls');
    expect(text).not.toMatch(/Settle round|Open round|Open nominations/);
  }, 30000);

  test('nothing threw on any page', () => {
    expect(pageErrors).toEqual([]);
  });
});
