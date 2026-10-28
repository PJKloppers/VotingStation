/**
 * Two recursion filters in one room, run to a winner each.
 *
 * A ballot holds two races drawn from the same pool of people:
 *
 *   Chairperson          nominate 2, need 2 nominations, choose 1 a round,
 *                        stops when someone has a majority
 *   Financial assistant  nominate 1, need 1 nomination, choose 1 a round,
 *                        runs until one person is left
 *
 * Both open for nominations at the same time, then each moves through its own
 * rounds on its own gate: one race can be in round 2 while the other is still
 * taking nominations, and a voter's phone shows whatever is open in each.
 *
 * The room is twelve voters. Five are people at a phone, each in their own
 * Brave profile, arriving at different times, typing their PIN a key at a
 * time, reading before they tap, sometimes tapping the wrong name first. The
 * other seven vote straight to the database as anon, at random moments while
 * the five are still deciding. A sixth Brave profile is the chair, and every
 * step of both races is a button on the chair's Live tab.
 *
 * Every vote is scripted, so each round's outcome is known in advance:
 *
 *   Chairperson
 *     Nominations  Anna 6, Ben 5, Cara 4, Dan 3, Eve 2, (four on 1)  → 5 through
 *     Round 1      Anna 4, Ben 3, Cara 3, Dan 1, Eve 1; drop 1       → tie at the
 *                  cut, the chair drops Eve; the chair then adds Gail from the pool
 *     Round 2      Anna 5, Ben 3, Gail 2, Cara 1, Dan 1; drop 2      → Cara, Dan out
 *     Round 3      Anna 7 of 12, Ben 4, Gail 1                        → Anna, by majority
 *
 *   Financial assistant
 *     Nominations  Gail 3, Hugo 3, Ivy 2, Jon 2, Anna 1, Finn 1      → 6 through
 *     Round 1      Gail 4, Hugo 3, Ivy 2, Jon 1, Anna 1, Finn 1; drop 3
 *                  → Jon, Anna, Finn out; the chair then withdraws Ivy
 *     Round 2      Gail 6, Hugo 6; drop 0                             → nobody out
 *     Round 3      Gail 7, Hugo 5; drop 1                             → Gail, last one in
 *
 * Run `bun run build` first. HEADED=1 watches it happen; SEED=n replays a run's
 * timing.
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

const CHAIR = 'Chairperson';
const FIN = 'Financial assistant';
const POOL = ['Anna Botha', 'Ben Cele', 'Cara Dlamini', 'Dan Els', 'Eve Fourie',
  'Finn Gous', 'Gail Hendricks', 'Hugo Ismail', 'Ivy Jacobs', 'Jon Kruger'];
const [ANNA, BEN, CARA, DAN, EVE, FINN, GAIL, HUGO, IVY, JON] = POOL as [
  string, string, string, string, string, string, string, string, string, string];

/** Who votes how, stage by stage. P1-P5 are people at a phone, A1-A7 are anon. */
const VOTERS = ['P1', 'P2', 'P3', 'P4', 'P5', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as const;
type Voter = (typeof VOTERS)[number];
type Script = Record<Voter, string[]>;

const CHAIR_NOMS: Script = {
  P1: [ANNA, BEN], P2: [ANNA, CARA], P3: [BEN, DAN], P4: [ANNA, EVE], P5: [CARA, FINN],
  A1: [ANNA, BEN], A2: [BEN, CARA], A3: [ANNA, DAN], A4: [BEN, CARA], A5: [ANNA, DAN],
  A6: [EVE, GAIL], A7: [HUGO, IVY],
};
const FIN_NOMS: Script = {
  P1: [GAIL], P2: [HUGO], P3: [GAIL], P4: [IVY], P5: [JON],
  A1: [HUGO], A2: [GAIL], A3: [HUGO], A4: [IVY], A5: [JON], A6: [ANNA], A7: [FINN],
};
const one = (xs: string[]): Script =>
  Object.fromEntries(VOTERS.map((v, i) => [v, [xs[i]!]])) as Script;
//                         P1    P2    P3    P4    P5    A1    A2    A3    A4    A5    A6    A7
const CHAIR_R1 = one([ANNA, BEN,  CARA, ANNA, DAN,  ANNA, BEN,  CARA, ANNA, BEN,  CARA, EVE ]);
const CHAIR_R2 = one([ANNA, GAIL, BEN,  ANNA, CARA, ANNA, BEN,  GAIL, ANNA, BEN,  DAN,  ANNA]);
const CHAIR_R3 = one([ANNA, ANNA, BEN,  ANNA, GAIL, ANNA, BEN,  ANNA, ANNA, BEN,  ANNA, BEN ]);
const FIN_R1   = one([GAIL, HUGO, GAIL, IVY,  JON,  HUGO, GAIL, HUGO, IVY,  GAIL, ANNA, FINN]);
const FIN_R2   = one([GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, HUGO]);
const FIN_R3   = one([GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, HUGO, GAIL, GAIL]);

/* ------------------------------------------------------------ human timing */

// A seeded generator, so a run that fails can be replayed with the same pauses.
let seed = Number(process.env.SEED ?? Date.now() % 100000);
const SEED = seed;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, between(min, max)));

/* ---------------------------------------------------------------- the room */

interface Phone { name: Voter; pin: string; browser: Browser; page: Page; dir: string }

let origin: string;
let stop: () => void;
let organizer: SupabaseClient;
let orgId = '';
let poolId = '';
let ballotId = '';
const qid: Record<string, string> = {};
/** Option ids per question, by label. */
const opt: Record<string, Record<string, string>> = {};
const pins: Partial<Record<Voter, string>> = {};
const phones: Phone[] = [];
let chairBrowser: Browser;
let chair: Page;
const profileDirs: string[] = [];
const pageErrors: string[] = [];
const log: string[] = [];
const note = (s: string) => { log.push(`${new Date().toISOString().slice(11, 23)} ${s}`); };

/** A Brave of its own: separate profile, cookies, storage and fingerprint. */
async function braveProfile(label: string): Promise<{ browser: Browser; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), `vs-${label}-`));
  profileDirs.push(dir);
  const browser = await puppeteer.launch({
    executablePath: braveExecutable(),
    headless: process.env.HEADED !== '1',
    userDataDir: dir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-brave-update',
      '--no-first-run', '--no-default-browser-check'],
  });
  return { browser, dir };
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
    .select('id').eq('owner_id', user.user!.id).limit(1).maybeSingle();
  orgId = org?.id ?? (await organizer.from('organizations')
    .insert({ owner_id: user.user!.id, slug: uniqueSlug('e2e-org'), name: 'E2E Org' })
    .select('id').single()).data!.id;

  // One pool of people, as an organizer keeps it between meetings.
  const { data: pool, error: pe } = await organizer.from('option_pools')
    .insert({ org_id: orgId, name: `Members ${Date.now().toString(36)}` }).select('id').single();
  if (pe) throw new Error(pe.message);
  poolId = pool!.id;
  await organizer.from('option_pool_entries')
    .insert(POOL.map((label, i) => ({ pool_id: poolId, label, sort_order: i })));

  const { data: ballot, error: be } = await organizer.from('ballots').insert({
    org_id: orgId, slug: uniqueSlug('e2e-room'), title: 'Annual General Meeting',
    status: 'live', mode: 'gated', allow_vote_change: true,
    results_public: true, show_results_after: true,
  }).select('id').single();
  if (be) throw new Error(be.message);
  ballotId = ballot!.id;

  const races = [
    { prompt: CHAIR, sort_order: 1, nominate_max: 2, nominate_threshold: 2, stop_on_majority: true },
    { prompt: FIN, sort_order: 2, nominate_max: 1, nominate_threshold: 1, stop_on_majority: false },
  ];
  for (const r of races) {
    const { data: q, error } = await organizer.from('questions_recursion_filter')
      .insert({ ballot_id: ballotId, pick_min: 1, pick_max: 1, ...r })
      .select('id').single();
    if (error) throw new Error(error.message);
    qid[r.prompt] = q!.id;
    // The same call the Questions tab makes: copy the pool in.
    const { error: ce } = await organizer.rpc('copy_pool_into_question', {
      p_pool: poolId, p_type: 'recursion_filter', p_question: q!.id,
    });
    if (ce) throw new Error(ce.message);
    const { data: os } = await organizer.from('options_recursion_filter')
      .select('id, label').eq('question_id', q!.id);
    opt[r.prompt] = Object.fromEntries((os ?? []).map((o) => [o.label, o.id]));
    if (Object.keys(opt[r.prompt]!).length !== POOL.length) {
      throw new Error(`${r.prompt}: the pool did not copy in whole.`);
    }
  }

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: VOTERS.length });
  (issued as Array<{ pin: string }>).forEach((t, i) => { pins[VOTERS[i]!] = t.pin; });

  // Six Brave profiles: the chair, and five people with phones.
  const c = await braveProfile('chair');
  chairBrowser = c.browser;
  chair = await chairBrowser.newPage();
  await chair.setViewport({ width: 1180, height: 1000 });
  chair.on('pageerror', (e) => pageErrors.push(`chair: ${e}`));
  chair.on('dialog', (d) => { note(`chair confirms: ${d.message()}`); void d.accept(); });

  await Promise.all((['P1', 'P2', 'P3', 'P4', 'P5'] as Voter[]).map(async (name) => {
    const { browser, dir } = await braveProfile(name);
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => pageErrors.push(`${name}: ${e}`));
    // Every answer the voter's page is given about itself, for when one goes wrong.
    page.on('response', async (r) => {
      if (!r.url().includes('/rpc/')) return;
      const fn = r.url().split('/rpc/')[1]?.split('?')[0];
      let body = '';
      try { body = await r.text(); } catch { return; }
      const bad = r.status() >= 400 || body.includes('"ok":false') || body.includes('"ok": false');
      note(`${name} rpc ${fn} ${r.status()}${bad ? ` REFUSED ${body.slice(0, 300)}` : ''}`);
    });
    phones.push({ name, pin: pins[name]!, browser, page, dir });
  }));
  phones.sort((a, b) => a.name.localeCompare(b.name));
  note(`seed ${SEED}; ballot ${ballotId}`);
}, 120000);

afterAll(async () => {
  await Promise.all([chairBrowser, ...phones.map((p) => p.browser)].map((b) => b?.close()));
  stop?.();
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  if (poolId) await organizer.from('option_pools').delete().eq('id', poolId);
  await organizer.auth.signOut();
  await Promise.all(profileDirs.map((d) => rm(d, { recursive: true, force: true })));
  const file = join(tmpdir(), `vs-room-${SEED}.log`);
  await Bun.write(file, log.join('\n'));
  console.log(`room log: ${file}`);
});

/* ----------------------------------------------------- the database's view */

async function race(prompt: string) {
  const { data } = await organizer.from('questions_recursion_filter')
    .select('phase, current_round, gate_open, winner_id').eq('id', qid[prompt]!).single();
  return data!;
}

/** Who is in each status, by label. */
async function standing(prompt: string): Promise<Record<string, string[]>> {
  const { data } = await organizer.from('options_recursion_filter')
    .select('label, status').eq('question_id', qid[prompt]!);
  const out: Record<string, string[]> = {};
  for (const o of data ?? []) (out[o.status] ??= []).push(o.label);
  for (const k of Object.keys(out)) out[k]!.sort();
  return out;
}

async function roundCounts(prompt: string, round: number): Promise<Record<string, number>> {
  const { data } = await organizer.rpc('ballot_results', { p_ballot: ballotId });
  const q = (data as { questions: Array<{ id: string; tally: { rounds: Array<{ round: number; tally: { options: Array<{ label: string; votes: number }> } }> } }> })
    .questions.find((x) => x.id === qid[prompt]);
  const r = q!.tally.rounds.find((x) => x.round === round)!;
  return Object.fromEntries(r.tally.options.filter((o) => o.votes > 0).map((o) => [o.label, o.votes]));
}

/* ------------------------------------------------------- the anon voters */

async function anonVote(who: Voter, prompt: string, labels: string[]) {
  await pause(300, 4000);   // they vote whenever they get round to it
  const { data, error } = await anonClient().rpc('cast_recursion_filter', {
    p_ballot: ballotId, p_pin: pins[who], p_question: qid[prompt],
    p_options: labels.map((l) => opt[prompt]![l]), p_abstain: false, p_fingerprint: null,
  });
  if (error) throw new Error(`${who} on ${prompt}: ${error.message}`);
  if (!(data as { ok: boolean }).ok) throw new Error(`${who} on ${prompt}: ${JSON.stringify(data)}`);
  note(`${who} (anon) → ${prompt}: ${labels.join(', ')}`);
}

const anonRoom = (prompt: string, script: Script) =>
  Promise.all((['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] as Voter[])
    .map((v) => anonVote(v, prompt, script[v])));

/* ------------------------------------------------------- the phones */

/** The voter's card for a question, in the round named, with names to tap. */
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

/** Misses: a tap that did not change the button it was aimed at. */
const misses: string[] = [];

/**
 * Taps a name and checks the tap took. A person sees their finger land; the
 * test has to look. A tap that changed nothing is recorded with whatever was
 * under it, and tried again.
 */
async function tap(card: ElementHandle<Element>, label: string, who = '?') {
  const buttons = await card.$$('.choice');
  for (const b of buttons) {
    const text = await b.evaluate((e) => (e as HTMLElement).innerText.replace('✓', '').trim());
    if (text !== label) continue;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await b.evaluate((e) => e.getAttribute('aria-pressed'));
      await b.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await pause(120, 300);
      await b.click();
      await pause(150, 250);
      const after = await b.evaluate((e) => e.isConnected ? e.getAttribute('aria-pressed') : 'detached');
      if (after !== before) return;
      const under = await b.evaluate((e) => {
        if (!e.isConnected) return 'the button is no longer on the page';
        const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
        return hit ? `${hit.tagName.toLowerCase()}.${hit.className} "${hit.innerText?.slice(0, 40)}"` : 'nothing';
      });
      misses.push(`${who} tapped ${label} (attempt ${attempt}); nothing changed; under the finger: ${under}`);
      note(`MISS ${misses[misses.length - 1]}`);
    }
    throw new Error(`${who}: tapping ${label} never took.`);
  }
  throw new Error(`No choice "${label}" on the card.`);
}

/** A person arriving: opens the link, types the PIN a key at a time. */
async function arrive(p: Phone) {
  await pause(200, 3000);
  await p.page.goto(`${origin}/#/vote/${ballotId}`, { waitUntil: 'networkidle0' });
  await p.page.waitForSelector('.pin-entry', { timeout: 15000 });
  await pause(600, 2000);                                    // finding the slip
  await p.page.type('.pin-entry', p.pin, { delay: between(90, 260) });
  await pause(200, 900);
  await p.page.click('button[type="submit"]');
  note(`${p.name} signs in`);
}

/**
 * A person voting on one card: reads it, maybe taps the wrong name first and
 * takes it back, taps their choices, looks again, submits.
 */
async function humanVote(p: Phone, prompt: string, stage: string, labels: string[], expectOn?: string[]) {
  const card = await ballotCard(p.page, prompt, stage);
  if (expectOn) expect(await labelsIn(card)).toEqual([...expectOn].sort());
  await pause(800, 3500);                                    // reading the names

  const multi = labels.length > 1 || (await card.$('.choice.multi')) !== null;
  if (rand() < 0.3) {
    const shown = await labelsIn(card);
    const wrong = shown.find((l) => !labels.includes(l));
    if (wrong) {
      await tap(card, wrong, p.name);
      note(`${p.name} taps ${wrong} by mistake`);
      await pause(400, 1500);
      if (multi) await tap(card, wrong, p.name);                     // and takes it back
    }
  }
  for (const l of labels) { await tap(card, l, p.name); await pause(300, 1400); }
  await pause(500, 2000);                                    // checking before sending
  const picked = await card.$$eval('.choice[aria-pressed="true"]',
    (n) => n.map((e) => (e as HTMLElement).innerText.replace('✓', '').trim()).sort());
  expect(picked).toEqual([...labels].sort());

  const submit = await card.$$('button.primary');
  const send = submit[submit.length - 1]!;
  const said = await send.evaluate((e) => (e as HTMLElement).innerText.trim());
  await send.click();
  // Found again rather than held: the card may be drawn afresh after a send.
  await p.page.waitForFunction((pr: string, st: string) =>
    [...document.querySelectorAll('.card')].some((c) =>
      (c.querySelector('h2') as HTMLElement | null)?.innerText.trim() === pr
      && (c.querySelector('.eyebrow') as HTMLElement | null)?.innerText.trim().toLowerCase() === st.toLowerCase()
      && (c as HTMLElement).innerText.includes('Your answer is recorded')),
  { timeout: 15000, polling: 200 }, prompt, stage).catch(async () => {
    const now = await p.page.evaluate((pr: string) =>
      [...document.querySelectorAll('.card')]
        .filter((c) => (c.querySelector('h2') as HTMLElement | null)?.innerText.trim() === pr)
        .map((c) => (c as HTMLElement).innerText).join('\n---\n'), prompt);
    throw new Error(`${p.name} pressed "${said}" on ${prompt} ${stage} for ${labels.join(', ')}, and nothing was recorded. The card reads:\n${now}`);
  });
  note(`${p.name} → ${prompt} ${stage}: ${labels.join(', ')}`);
}

/** Every phone votes on one card, each at their own pace. */
const phonesVote = (prompt: string, stage: string, script: Script, expectOn?: string[]) =>
  Promise.all(phones.map((p) => humanVote(p, prompt, stage, script[p.name], expectOn)));

/** What a phone has open to vote on right now: "prompt|stage" for each card. */
const openOn = (p: Phone) => p.page.evaluate(() =>
  [...document.querySelectorAll('.card')]
    .filter((c) => c.hasAttribute('data-question-card'))
    .map((c) => `${(c.querySelector('h2') as HTMLElement).innerText.trim()}|${(c.querySelector('.eyebrow') as HTMLElement).innerText.trim().toLowerCase()}`)
    .sort());

/** Waits until every phone shows exactly these cards, with nothing pressed. */
async function phonesShow(cards: string[], timeout = 30000) {
  const want = [...cards].map((c) => c.toLowerCase()).sort();
  await Promise.all(phones.map((p) => p.page.waitForFunction((w: string[]) => {
    const got = [...document.querySelectorAll('.card')]
      .filter((c) => c.hasAttribute('data-question-card'))
      .map((c) => `${(c.querySelector('h2') as HTMLElement).innerText.trim()}|${(c.querySelector('.eyebrow') as HTMLElement).innerText.trim()}`.toLowerCase())
      .sort();
    return JSON.stringify(got) === JSON.stringify(w);
  }, { timeout, polling: 300 }, want).catch(async () => {
    throw new Error(`${p.name} shows ${JSON.stringify(await openOn(p))}, expected ${JSON.stringify(want)}`);
  })));
}

/* ------------------------------------------------------------ the chair */

/** The chair's card for one race on the Live tab. */
async function raceCard(prompt: string) {
  const handle = await chair.waitForFunction((p: string) =>
    [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p) ?? false,
  { timeout: 15000, polling: 250 }, prompt);
  return handle.asElement() as ElementHandle<Element>;
}

const raceText = async (prompt: string) =>
  (await raceCard(prompt)).evaluate((e) => (e as HTMLElement).innerText);

/** Presses a button on one race's card, matched exactly or by its start. */
async function press(prompt: string, label: string, exact = false) {
  await pause(400, 1200);                                    // the chair finds the button
  const handle = await chair.waitForFunction((p: string, l: string, ex: boolean) => {
    const card = [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p);
    if (!card) return false;
    return [...card.querySelectorAll('button')].find((b) => {
      const t = (b as HTMLElement).innerText.trim();
      return !(b as HTMLButtonElement).disabled && (ex ? t === l : t.startsWith(l));
    }) ?? false;
  }, { timeout: 20000, polling: 250 }, prompt, label, exact);
  await (handle.asElement() as ElementHandle<Element>).click();
  note(`chair presses "${label}" on ${prompt}`);
}

async function chairSees(prompt: string, text: string, timeout = 20000) {
  await chair.waitForFunction((p: string, t: string) => {
    const card = [...document.querySelectorAll('.card')].find((c) =>
      (c.querySelector('h3') as HTMLElement | null)?.innerText.trim() === p);
    return !!card && (card as HTMLElement).innerText.toLowerCase().includes(t.toLowerCase());
  }, { timeout, polling: 250 }, prompt, text).catch(async () => {
    throw new Error(`Chair's "${prompt}" card never showed "${text}". It reads:\n${await raceText(prompt)}`);
  });
}

/**
 * Settles a round through the chair's dialog: answers "how do people drop
 * out?", checks what the preview says, breaks any tie, and settles.
 */
async function settleWith(
  prompt: string, round: number, rule: 'votes' | 'count' | 'none' | null, n: number | null,
  opts: { expect?: string[]; cutTie?: string[]; seatTie?: string[] } = {},
) {
  await press(prompt, `Settle round ${round}…`, true);
  const dialog = (await chair.waitForSelector('dialog[open]', { timeout: 10000 }))!;
  await pause(600, 1500);                                    // the chair reads the counts
  if (rule === 'none') {
    await (await dialog.$('input[name="drop_rule"][value="none"]'))!.click();
  } else if (rule) {
    const input = (await dialog.$(`input[name="drop_${rule === 'votes' ? 'votes' : 'count'}"]`))!;
    await input.click();
    await input.evaluate((e) => { (e as HTMLInputElement).select(); });
    await input.type(String(n), { delay: between(80, 200) });
  }
  note(`chair answers ${rule ?? '(nothing to ask)'} ${n ?? ''} on ${prompt} round ${round}`);
  for (const text of opts.expect ?? []) {
    await chair.waitForFunction((t: string) =>
      (document.querySelector('dialog[open]') as HTMLElement | null)?.innerText.toLowerCase().includes(t.toLowerCase()) ?? false,
    { timeout: 10000, polling: 200 }, text).catch(async () => {
      const shown = await chair.evaluate(() => (document.querySelector('dialog[open]') as HTMLElement | null)?.innerText ?? '(no dialog)');
      throw new Error(`The settle dialog never showed "${text}". It reads:\n${shown}`);
    });
  }
  for (const [name, who] of [['cut_tie', opts.cutTie], ['seat_tie', opts.seatTie]] as const) {
    for (const label of who ?? []) {
      const boxes = await dialog.$$(`label.check:has(input[name="${name}"])`);
      for (const b of boxes) {
        if ((await b.evaluate((e) => (e as HTMLElement).innerText.trim())) === label) await b.click();
      }
      await pause(300, 800);
    }
  }
  const settle = await chair.waitForFunction((r: number) =>
    [...document.querySelectorAll('dialog[open] button')].find((b) =>
      (b as HTMLElement).innerText.trim() === `Settle round ${r}` && !(b as HTMLButtonElement).disabled) ?? false,
  { timeout: 10000, polling: 200 }, round);
  await (settle.asElement() as ElementHandle<Element>).click();
  await chair.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 15000 });
  note(`chair settles ${prompt} round ${round}`);
}

/** Answers "how many seats are being filled?" before round 1. */
async function confirmSeats(prompt: string, n: number) {
  await chairSees(prompt, 'How many seats are being filled?');
  const card = await raceCard(prompt);
  const input = (await card.$('input[name="confirm_seats"]'))!;
  await input.click();
  await input.evaluate((e) => { (e as HTMLInputElement).select(); });
  await input.type(String(n), { delay: between(80, 200) });
  await press(prompt, `Confirm ${n} seat`);
}

/** Unfolds "More controls" on a race's card. */
async function openMore(prompt: string) {
  const card = await raceCard(prompt);
  const open = await card.$eval('details.more-controls', (d) => (d as HTMLDetailsElement).open);
  if (!open) await (await card.$('details.more-controls > summary'))!.click();
  await pause(300, 700);
}

const refreshChair = async () => {
  await chair.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x as HTMLElement).innerText.trim() === 'Refresh');
    (b as HTMLButtonElement | undefined)?.click();
  });
  await pause(800, 1200);
};

/* ===================================================================== */

describe('two recursion filters, one room, run to a winner each', () => {
  test('the chair signs in and both races wait at nominations', async () => {
    const { email, password } = credentials();
    await chair.goto(`${origin}/#/signin`, { waitUntil: 'networkidle0' });
    await chair.waitForSelector('input[name="email"]', { timeout: 15000 });
    await chair.type('input[name="email"]', email, { delay: 30 });
    await chair.type('input[name="password"]', password, { delay: 30 });
    await chair.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x as HTMLElement).innerText.trim() === 'Sign in');
      (b as HTMLButtonElement).click();
    });
    await chair.waitForFunction(() => document.body.innerText.includes('Your ballots'), { timeout: 20000 });
    await chair.goto(`${origin}/#/manage/${ballotId}`, { waitUntil: 'networkidle0' });

    for (const prompt of [CHAIR, FIN]) {
      await chairSees(prompt, 'Not opened yet');
      await chairSees(prompt, 'Open nominations');
    }
  }, 60000);

  test('five people arrive at different times and wait', async () => {
    await Promise.all(phones.map(arrive));
    await Promise.all(phones.map((p) => p.page.waitForFunction(
      () => document.body.innerText.includes('No question is open yet'), { timeout: 20000 })));
  }, 60000);

  test('the chair opens both nominations; every phone shows both at once', async () => {
    await press(CHAIR, 'Open nominations');
    await chairSees(CHAIR, 'Voting');
    await press(FIN, 'Open nominations');
    await chairSees(FIN, 'Voting');

    expect((await race(CHAIR)).gate_open).toBe(true);
    expect((await race(FIN)).gate_open).toBe(true);
    await phonesShow([`${CHAIR}|nominations`, `${FIN}|nominations`]);

    const card = await ballotCard(phones[0]!.page, CHAIR, 'Nominations');
    expect(await labelsIn(card)).toEqual([...POOL].sort());
    expect(await card.evaluate((e) => (e as HTMLElement).innerText)).toContain('Nominate up to 2 people');
  }, 60000);

  test('the room nominates for both, in whatever order they like', async () => {
    // P5 first nominates Cara and Ben, then changes their mind.
    const first: Script = { ...CHAIR_NOMS, P5: [CARA, BEN] };
    await Promise.all([
      ...phones.map(async (p) => {
        const order = rand() < 0.5 ? [CHAIR, FIN] : [FIN, CHAIR];
        for (const prompt of order) {
          await humanVote(p, prompt, 'Nominations', (prompt === CHAIR ? first : FIN_NOMS)[p.name]);
        }
      }),
      anonRoom(CHAIR, CHAIR_NOMS),
      anonRoom(FIN, FIN_NOMS),
    ]);

    const p5 = phones[4]!;
    const card = await ballotCard(p5.page, CHAIR, 'Nominations');
    await pause(1000, 2500);
    await tap(card, BEN, 'P5');                                     // un-nominate Ben
    await pause(400, 1200);
    await tap(card, FINN, 'P5');
    await pause(600, 1500);
    const buttons = await card.$$('button.primary');
    const change = buttons[buttons.length - 1]!;
    expect(await change.evaluate((e) => (e as HTMLElement).innerText)).toContain('Change my vote');
    await change.click();
    await p5.page.waitForFunction((el: Element) =>
      (el as HTMLElement).innerText.includes('Your answer is recorded'), { timeout: 15000 }, card);
    note('P5 changes their nominations to Cara, Finn');

    expect(await roundCounts(CHAIR, 0)).toEqual(
      { [ANNA]: 6, [BEN]: 5, [CARA]: 4, [DAN]: 3, [EVE]: 2, [FINN]: 1, [GAIL]: 1, [HUGO]: 1, [IVY]: 1 });
    expect(await roundCounts(FIN, 0)).toEqual(
      { [GAIL]: 3, [HUGO]: 3, [IVY]: 2, [JON]: 2, [ANNA]: 1, [FINN]: 1 });
  }, 180000);

  test('closing Chairperson nominations leaves Financial assistant open on every phone', async () => {
    await refreshChair();
    await chairSees(CHAIR, '12 voted so far');
    await press(CHAIR, 'Close nominations');
    await chairSees(CHAIR, 'Closed — settle it');

    expect((await race(CHAIR)).gate_open).toBe(false);
    expect((await race(FIN)).gate_open).toBe(true);
    await phonesShow([`${FIN}|nominations`]);
  }, 60000);

  test('settling Chairperson nominations puts five through; four on 1 stay in the pool', async () => {
    await press(CHAIR, 'Settle nominations');
    await confirmSeats(CHAIR, 1);
    await chairSees(CHAIR, 'Open round 1');
    await chairSees(CHAIR, '5 in this round');
    expect((await standing(CHAIR)).in).toEqual([ANNA, BEN, CARA, DAN, EVE].sort());
    expect((await race(CHAIR)).phase).toBe('eliminating');
  }, 60000);

  test('Chairperson round 1 opens while Financial assistant still takes nominations', async () => {
    await press(CHAIR, 'Open round 1');
    await chairSees(CHAIR, 'Voting');
    await phonesShow([`${CHAIR}|round 1`, `${FIN}|nominations`]);

    await Promise.all([
      phonesVote(CHAIR, 'Round 1', CHAIR_R1, [ANNA, BEN, CARA, DAN, EVE]),
      anonRoom(CHAIR, CHAIR_R1),
    ]);
    expect(await roundCounts(CHAIR, 1)).toEqual({ [ANNA]: 4, [BEN]: 3, [CARA]: 3, [DAN]: 1, [EVE]: 1 });
  }, 120000);

  test('Financial assistant nominations close and settle; its round 1 runs beside Chairperson\'s', async () => {
    await press(FIN, 'Close nominations');
    await chairSees(FIN, 'Closed — settle it');
    expect((await race(CHAIR)).gate_open).toBe(true);           // the other race is untouched

    await press(FIN, 'Settle nominations');
    await confirmSeats(FIN, 1);
    await chairSees(FIN, '6 in this round');
    expect((await standing(FIN)).in).toEqual([GAIL, HUGO, IVY, JON, ANNA, FINN].sort());

    await press(FIN, 'Open round 1');
    await phonesShow([`${CHAIR}|round 1`, `${FIN}|round 1`]);

    await Promise.all([
      phonesVote(FIN, 'Round 1', FIN_R1, [GAIL, HUGO, IVY, JON, ANNA, FINN]),
      anonRoom(FIN, FIN_R1),
    ]);
    expect(await roundCounts(FIN, 1)).toEqual(
      { [GAIL]: 4, [HUGO]: 3, [IVY]: 2, [JON]: 1, [ANNA]: 1, [FINN]: 1 });
  }, 150000);

  test('Chairperson round 1: the dialog shows a tie at the cut, and the chair breaks it', async () => {
    await press(CHAIR, 'Close round 1');
    await chairSees(CHAIR, 'Closed — settle it');
    // asked how people drop out: the lowest 1, which falls on Dan and Eve
    await settleWith(CHAIR, 1, 'count', 1, {
      expect: [`${DAN} — tied at the cut`, `${EVE} — tied at the cut`, 'Choose 1 to drop'],
      cutTie: [EVE],
    });
    await chairSees(CHAIR, 'Open round 2');

    const s = await standing(CHAIR);
    expect(s.dropped).toEqual([EVE]);
    expect(s.in).toEqual([ANNA, BEN, CARA, DAN].sort());
  }, 90000);

  test('between rounds the chair adds Gail from the pool; she is on round 2', async () => {
    await openMore(CHAIR);
    const card = await raceCard(CHAIR);
    const select = await card.$('select[name="add_candidate"]');
    await select!.select(opt[CHAIR]![GAIL]!);
    await press(CHAIR, 'Add', true);
    await chairSees(CHAIR, `${GAIL} · added by you`);
    expect((await standing(CHAIR)).in).toEqual([ANNA, BEN, CARA, DAN, GAIL].sort());

    await press(CHAIR, 'Open round 2');
    await phonesShow([`${CHAIR}|round 2`, `${FIN}|round 1`]);
    await Promise.all([
      phonesVote(CHAIR, 'Round 2', CHAIR_R2, [ANNA, BEN, CARA, DAN, GAIL]),
      anonRoom(CHAIR, CHAIR_R2),
    ]);
    expect(await roundCounts(CHAIR, 2)).toEqual({ [ANNA]: 5, [BEN]: 3, [GAIL]: 2, [CARA]: 1, [DAN]: 1 });
  }, 150000);

  test('Financial assistant round 1 drops three; the chair withdraws Ivy before round 2', async () => {
    await press(FIN, 'Close round 1');
    await chairSees(FIN, 'Closed — settle it');
    await settleWith(FIN, 1, 'count', 3, { expect: ['3 drop · 3 stay for 1 seat'] });
    await chairSees(FIN, 'Open round 2');
    expect((await standing(FIN)).dropped).toEqual([JON, ANNA, FINN].sort());

    await openMore(FIN);
    await chairSees(FIN, IVY);
    const card = await raceCard(FIN);
    const rows = await card.$$('.row');
    let withdrew = false;
    for (const r of rows) {
      const t = await r.evaluate((e) => (e as HTMLElement).innerText);
      if (t.startsWith(IVY) && t.includes('Withdraw')) {
        await pause(500, 1500);
        await (await r.$('button'))!.click();                // confirm() is accepted by the dialog handler
        withdrew = true;
        break;
      }
    }
    expect(withdrew).toBe(true);
    for (let i = 0; i < 40 && !(await standing(FIN)).withdrawn; i++) await pause(250, 250);
    expect((await standing(FIN)).withdrawn).toEqual([IVY]);
    expect((await standing(FIN)).in).toEqual([GAIL, HUGO].sort());
  }, 90000);

  test('one person reloads their phone mid-meeting and carries on', async () => {
    const p3 = phones[2]!;
    await p3.page.reload({ waitUntil: 'networkidle0' });
    await p3.page.waitForSelector('.pin-entry', { timeout: 15000 });
    await pause(800, 2000);
    await p3.page.type('.pin-entry', p3.pin, { delay: between(100, 250) });
    await p3.page.click('button[type="submit"]');
    note('P3 reloads and signs in again');
    // Chairperson round 2 is still open and already answered; nothing else is.
    await p3.page.waitForFunction(() => document.body.innerText.includes('Change my vote'), { timeout: 20000 });
  }, 60000);

  test('Chairperson round 2 drops two; Financial assistant round 2 opens alongside round 3', async () => {
    await press(CHAIR, 'Close round 2');
    await chairSees(CHAIR, 'Closed — settle it');
    await settleWith(CHAIR, 2, 'count', 2, { expect: [`${CARA} — drops`, `${DAN} — drops`] });
    await chairSees(CHAIR, 'Open round 3');
    expect((await standing(CHAIR)).in).toEqual([ANNA, BEN, GAIL].sort());

    await press(FIN, 'Open round 2');
    await press(CHAIR, 'Open round 3');
    await phonesShow([`${CHAIR}|round 3`, `${FIN}|round 2`]);

    await Promise.all([
      ...phones.map(async (p) => {
        const order = rand() < 0.5 ? [CHAIR, FIN] : [FIN, CHAIR];
        for (const prompt of order) {
          if (prompt === CHAIR) await humanVote(p, CHAIR, 'Round 3', CHAIR_R3[p.name], [ANNA, BEN, GAIL]);
          else await humanVote(p, FIN, 'Round 2', FIN_R2[p.name], [GAIL, HUGO]);
        }
      }),
      anonRoom(CHAIR, CHAIR_R3),
      anonRoom(FIN, FIN_R2),
    ]);
    expect(await roundCounts(CHAIR, 3)).toEqual({ [ANNA]: 7, [BEN]: 4, [GAIL]: 1 });
    expect(await roundCounts(FIN, 2)).toEqual({ [GAIL]: 6, [HUGO]: 6 });
  }, 240000);

  test('Chairperson: Anna has 7 of 12, so settling ends it with her as winner', async () => {
    await press(CHAIR, 'Close round 3');
    await chairSees(CHAIR, 'Closed — settle it');
    // nothing to ask: the majority decides it
    await settleWith(CHAIR, 3, null, null, { expect: ['This round decides the winner', `${ANNA} — elected`] });
    await chairSees(CHAIR, `Won: ${ANNA}`);

    const r = await race(CHAIR);
    expect(r.phase).toBe('decided');
    expect(r.winner_id).toBe(opt[CHAIR]![ANNA]!);
    await phonesShow([`${FIN}|round 2`]);
  }, 60000);

  test('Financial assistant round 2 is a dead heat; a drop of 0 sends the same two again', async () => {
    await press(FIN, 'Close round 2');
    await chairSees(FIN, 'Closed — settle it');
    await settleWith(FIN, 2, 'none', null, { expect: ['0 drop · 2 stay for 1 seat'] });
    await chairSees(FIN, 'Open round 3');
    expect((await standing(FIN)).in).toEqual([GAIL, HUGO].sort());
    expect((await race(FIN)).current_round).toBe(3);
  }, 60000);

  test('Financial assistant round 3: one drops, and Gail is the last one in', async () => {
    await press(FIN, 'Open round 3');
    await phonesShow([`${FIN}|round 3`]);
    await Promise.all([
      phonesVote(FIN, 'Round 3', FIN_R3, [GAIL, HUGO]),
      anonRoom(FIN, FIN_R3),
    ]);
    expect(await roundCounts(FIN, 3)).toEqual({ [GAIL]: 7, [HUGO]: 5 });

    await press(FIN, 'Close round 3');
    await chairSees(FIN, 'Closed — settle it');
    // a rule that would leave nobody is refused before it is sent
    await settleWith(FIN, 3, 'votes', 7, { expect: ['leaves 0 for 1 seat'] }).catch(() => undefined);
    await chair.keyboard.press('Escape');
    await chair.waitForFunction(() => !document.querySelector('dialog[open]'), { timeout: 10000 });
    await settleWith(FIN, 3, 'votes', 5, { expect: [`${HUGO} — drops`, '1 drop · 1 stay for 1 seat'] });
    await chairSees(FIN, `Won: ${GAIL}`);

    const r = await race(FIN);
    expect(r.phase).toBe('decided');
    expect(r.winner_id).toBe(opt[FIN]![GAIL]!);
  }, 120000);

  test('both races are decided; the phones have nothing left to vote on', async () => {
    await phonesShow([]);
    const chairText = await raceText(CHAIR);
    const finText = await raceText(FIN);
    expect(chairText.toLowerCase()).toContain(`won: ${ANNA}`.toLowerCase());
    // the round notes sit in the folded "Round by round" section
    const finAll = await (await raceCard(FIN)).evaluate((e) => e.textContent ?? '');
    expect(finAll).toContain('everyone on 5 votes or fewer dropped');
    expect(finText.toLowerCase()).toContain(`won: ${GAIL}`.toLowerCase());
    // The stages each race went through, as the chair sees them.
    expect(chairText).toMatch(/✓ Nominations[\s\S]*✓ Round 1[\s\S]*✓ Round 2[\s\S]*✓ Round 3/i);
    expect(finText).toMatch(/✓ Nominations[\s\S]*✓ Round 1[\s\S]*✓ Round 2[\s\S]*✓ Round 3/i);
    // And the record of each round is in the database.
    const { data } = await organizer.from('rounds_recursion_filter')
      .select('question_id, round_no, settled_at').in('question_id', [qid[CHAIR]!, qid[FIN]!]);
    expect(data!.filter((r) => r.settled_at).length).toBe(8);
  }, 60000);

  test('nothing threw on any page', () => {
    if (misses.length) console.log(`taps that missed and were retried:\n  ${misses.join('\n  ')}`);
    expect(pageErrors).toEqual([]);
  });
});
