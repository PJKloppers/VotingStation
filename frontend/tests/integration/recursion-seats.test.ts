/**
 * A committee of ten and a chairperson, elected side by side, against the
 * real database.
 *
 * Both races are "Narrow it down"; the only difference is the seats: 10 for
 * the committee, 1 for the chair. Forty voters vote in every round, and they
 * vote at the same moment -- forty separate anonymous clients, all sent
 * together -- so the counts are checked under the load of a room, not one
 * ballot at a time. Every count is scripted, so each round's outcome is known:
 *
 *   Committee, 10 seats, 18 on the shortlist
 *     Round 1  10 open, up to 10 votes  P01-P05 have a majority: elected.
 *              The chair: everyone on 3 or fewer drops (P15-P18).
 *     Round 2  5 open, up to 5           P06, P07 elected. The lowest 2 drop.
 *     Round 3  3 open, up to 3           No majority. The lowest 1, a tie at
 *              the cut: the chair drops P12.
 *     Round 4  3 open, up to 3           Four have a majority for three seats,
 *              the last on a tie: the chair elects P10. All ten seats filled.
 *
 *   Chairperson, 1 seat
 *     Round 1  no majority; everyone on 5 or fewer drops
 *     Round 2  a majority wins
 *
 * Alongside: who may press the chair's buttons (only the ballot's owner), and
 * what a voter cannot do (more votes than seats, vote for someone elected).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  anonClient, organizerClient, otherOrganizerClient, uniqueSlug,
} from '../helpers/env';

const VOTERS = 40;
let organizer: SupabaseClient;
let stranger: SupabaseClient;
let ballotId = '';
let committee = '';
let chair = '';
let pins: string[] = [];
const ids: Record<string, Record<string, string>> = {};

type Answer = {
  ok: boolean; error?: string; message?: string; needs?: string;
  tied?: Array<{ id: string; label: string }>; drop_from_tie?: number; elect_from_tie?: number;
  tally?: { drop: string[]; drop_error: string | null };
};

const rpc = async <T = Answer>(client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
};

/**
 * Ballots that produce exactly these counts: each person's votes go to the
 * voters holding the fewest picks so far, so nobody exceeds `max` and every
 * voter takes part when there are enough votes to go round.
 */
function ballotsFor(counts: Record<string, number>, max: number): string[][] {
  const ballots: string[][] = Array.from({ length: VOTERS }, () => []);
  const order = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [label, n] of order) {
    const takers = ballots.map((b, i) => ({ i, n: b.length }))
      .sort((a, b) => a.n - b.n || a.i - b.i).slice(0, n);
    for (const t of takers) ballots[t.i]!.push(label);
  }
  for (const b of ballots) if (b.length > max) throw new Error(`a ballot of ${b.length} for ${max} votes`);
  return ballots;
}

/** Forty voters, forty clients, all at once. */
async function roomVotes(question: string, ballots: string[][]) {
  const answers = await Promise.all(ballots.map((labels, i) => {
    if (labels.length === 0) return Promise.resolve({ ok: true } as Answer);
    return rpc(anonClient(), 'cast_recursion_filter', {
      p_ballot: ballotId, p_pin: pins[i], p_question: question,
      p_options: labels.map((l) => ids[question]![l]), p_abstain: false, p_fingerprint: null,
    });
  }));
  const refused = answers.filter((a) => !a.ok);
  if (refused.length) throw new Error(`${refused.length} votes refused: ${refused[0]!.error}`);
}

const gate = (question: string, open: boolean) =>
  rpc(organizer, 'set_gate', { p_ballot: ballotId, p_type: 'recursion_filter', p_question: question, p_open: open });

type Race = { current_round: number; rounds: Array<{ round: number; tally: { options: Array<{ label: string; votes: number }> } }> };

/** The current round's count, as the chair sees it. */
async function counts(question: string): Promise<Record<string, number>> {
  const r = await rpc<{ questions: Array<{ id: string; tally: Race }> }>(organizer, 'ballot_results', { p_ballot: ballotId });
  const race = r.questions.find((q) => q.id === question)!.tally;
  const t = race.rounds.find((x) => x.round === race.current_round)!.tally;
  return Object.fromEntries(t.options.filter((o) => o.votes > 0).map((o) => [o.label, o.votes]));
}

async function seated(question: string): Promise<string[]> {
  const { data } = await organizer.from('options_recursion_filter')
    .select('label, seat_no').eq('question_id', question).eq('status', 'elected').order('seat_no');
  return (data ?? []).map((o) => o.label);
}

async function race(question: string) {
  const { data } = await organizer.from('questions_recursion_filter')
    .select('phase, current_round, winner_id, seats').eq('id', question).single();
  return data!;
}

beforeAll(async () => {
  organizer = await organizerClient();
  stranger = await otherOrganizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();

  const { data: ballot, error } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('seats'), title: 'Seats Run',
    status: 'live', mode: 'gated', allow_vote_change: true, results_public: true,
  }).select('id').single();
  if (error) throw new Error(error.message);
  ballotId = ballot!.id;

  const make = async (prompt: string, seats: number, extra: Record<string, unknown>, people: string[]) => {
    const { data: q, error: qe } = await organizer.from('questions_recursion_filter')
      .insert({ ballot_id: ballotId, prompt, seats, sort_order: seats, ...extra })
      .select('id').single();
    if (qe) throw new Error(qe.message);
    const { data: os } = await organizer.from('options_recursion_filter')
      .insert(people.map((label, i) => ({ question_id: q!.id, label, sort_order: i })))
      .select('id, label');
    ids[q!.id] = Object.fromEntries((os ?? []).map((o) => [o.label, o.id]));
    return q!.id as string;
  };
  const P = Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`);
  committee = await make('Committee', 10,
    { nominate_max: 10, nominate_threshold: 2, stop_on_majority: true, pick_min: 1, pick_max: 10 }, P);
  chair = await make('Chairperson', 1,
    { nominate_max: 1, nominate_threshold: 1, stop_on_majority: true }, ['Amy', 'Bo', 'Cy', 'Di']);

  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: VOTERS });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);
}, 60000);

afterAll(async () => {
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
  await stranger.auth.signOut();
});

/* ======================================================================== */

describe('who may run a race', () => {
  test('a voter (anon) cannot press the chair\'s buttons', async () => {
    for (const [fn, args] of [
      ['set_round_drop', { p_question: committee, p_rule: 'none', p_n: null }],
      ['settle_round', { p_question: committee }],
      ['end_recursion_seats', { p_question: committee, p_elect: [] }],
      ['add_candidate', { p_question: committee, p_option: ids[committee]!.P01 }],
    ] as const) {
      const { error } = await anonClient().rpc(fn, args);
      expect(error?.message ?? '').toMatch(/permission denied|not find/i);
    }
  });

  test('another organizer cannot either', async () => {
    for (const [fn, args] of [
      ['set_round_drop', { p_question: committee, p_rule: 'none', p_n: null }],
      ['settle_round', { p_question: committee }],
      ['end_recursion_seats', { p_question: committee, p_elect: [] }],
    ] as const) {
      const { error } = await stranger.rpc(fn, args);
      expect(error?.message ?? '').toContain('Not your ballot');
    }
    const { error } = await stranger.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'recursion_filter', p_question: committee, p_open: true,
    });
    expect(error?.message ?? '').toContain('Not your ballot');
  });
});

describe('a committee of ten and a chairperson, side by side', () => {
  test('both take nominations at once; 18 reach the committee shortlist', async () => {
    await gate(committee, true);
    await gate(chair, true);
    const noms: Record<string, number> = {};
    for (let i = 1; i <= 18; i++) noms[`P${String(i).padStart(2, '0')}`] = 10;
    noms.P19 = 1; noms.P20 = 1;
    await Promise.all([
      roomVotes(committee, ballotsFor(noms, 10)),
      roomVotes(chair, ballotsFor({ Amy: 12, Bo: 11, Cy: 9, Di: 8 }, 1)),
    ]);
    await gate(committee, false);
    const a = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(a.message).toBe('18 people go through to round 1.');
    expect((await race(committee)).current_round).toBe(1);
  }, 60000);

  test('the seats are fixed once the vote has started', async () => {
    const { error } = await organizer.from('questions_recursion_filter').update({ seats: 9 }).eq('id', committee);
    expect(error?.message ?? '').toContain('fixed once the vote has started');
  });

  test('round 1: ten votes each; five have a majority and are elected', async () => {
    await gate(committee, true);
    // more votes than seats is refused
    const over = await rpc(anonClient(), 'cast_recursion_filter', {
      p_ballot: ballotId, p_pin: pins[0], p_question: committee,
      p_options: Object.values(ids[committee]!).slice(0, 11), p_abstain: false, p_fingerprint: null,
    });
    expect(over.ok).toBe(false);
    expect(over.error).toBe('Please choose at most 10.');

    const r1 = {
      P01: 30, P02: 29, P03: 28, P04: 25, P05: 22, P06: 18, P07: 15, P08: 12, P09: 10,
      P10: 9, P11: 8, P12: 6, P13: 5, P14: 4, P15: 3, P16: 3, P17: 2, P18: 1,
    };
    const ballots = ballotsFor(r1, 10);
    // a voter who taps "submit" twice at once is counted once: the second may
    // be refused or may replace the first, but never adds to it
    await Promise.all([
      roomVotes(committee, ballots),
      roomVotes(committee, [ballots[0]!]).catch(() => undefined),
    ]);
    expect(await counts(committee)).toEqual(r1);
    await gate(committee, false);

    const first = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(first.needs).toBe('drop_rule');

    const tooMany = await rpc(organizer, 'set_round_drop', { p_question: committee, p_rule: 'votes', p_n: 15 });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.error).toContain('for 5 seats');

    const rule = await rpc(organizer, 'set_round_drop', { p_question: committee, p_rule: 'votes', p_n: 3 });
    expect(rule.ok).toBe(true);
    const done = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(done.message).toBe('P01, P02, P03, P04, P05 elected. Round 2: 9 left for 5 seat(s).');
    expect(await seated(committee)).toEqual(['P01', 'P02', 'P03', 'P04', 'P05']);
  }, 60000);

  test('the chairperson\'s round 1 runs meanwhile: no majority, the lowest drop', async () => {
    const r = await rpc(organizer, 'settle_round', { p_question: chair });
    expect(r.ok).toBe(false);                                    // its nominations are still open
    await gate(chair, false);
    expect((await rpc(organizer, 'settle_round', { p_question: chair })).message).toBe('4 people go through to round 1.');
    await gate(chair, true);
    await roomVotes(chair, ballotsFor({ Amy: 16, Bo: 14, Cy: 6, Di: 4 }, 1));
    await gate(chair, false);
    expect((await rpc(organizer, 'settle_round', { p_question: chair })).needs).toBe('drop_rule');
    await rpc(organizer, 'set_round_drop', { p_question: chair, p_rule: 'votes', p_n: 6 });
    const a = await rpc(organizer, 'settle_round', { p_question: chair });
    expect(a.message).toBe('Round 2 is ready with 2 candidates.');
  }, 60000);

  test('round 2: five votes each; two more elected, the lowest two drop', async () => {
    await gate(committee, true);
    const elected = await rpc(anonClient(), 'cast_recursion_filter', {
      p_ballot: ballotId, p_pin: pins[0], p_question: committee,
      p_options: [ids[committee]!.P01], p_abstain: false, p_fingerprint: null,
    });
    expect(elected.ok).toBe(false);                              // P01 already holds a seat
    const six = await rpc(anonClient(), 'cast_recursion_filter', {
      p_ballot: ballotId, p_pin: pins[0], p_question: committee,
      p_options: ['P06', 'P07', 'P08', 'P09', 'P10', 'P11'].map((l) => ids[committee]![l]),
      p_abstain: false, p_fingerprint: null,
    });
    expect(six.error).toBe('Please choose at most 5.');

    const r2 = { P06: 26, P07: 24, P08: 20, P09: 18, P10: 15, P11: 10, P12: 8, P13: 6, P14: 2 };
    await roomVotes(committee, ballotsFor(r2, 5));
    expect(await counts(committee)).toEqual(r2);
    await gate(committee, false);
    await rpc(organizer, 'set_round_drop', { p_question: committee, p_rule: 'count', p_n: 2 });
    const a = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(a.message).toBe('P06, P07 elected. Round 3: 5 left for 3 seat(s).');
  }, 60000);

  test('the chairperson is decided by a majority while the committee goes on', async () => {
    await gate(chair, true);
    await roomVotes(chair, ballotsFor({ Amy: 23, Bo: 17 }, 1));
    await gate(chair, false);
    const a = await rpc(organizer, 'settle_round', { p_question: chair });
    expect(a.message).toBe('Amy wins with a majority.');
    const c = await race(chair);
    expect(c.phase).toBe('decided');
    expect(c.winner_id).toBe(ids[chair]!.Amy!);
    expect((await race(committee)).phase).toBe('eliminating');
  }, 60000);

  test('round 3: nobody has a majority; the cut falls on a tie and the chair breaks it', async () => {
    await gate(committee, true);
    const r3 = { P08: 20, P09: 19, P10: 15, P11: 12, P12: 12 };
    await roomVotes(committee, ballotsFor(r3, 3));
    expect(await counts(committee)).toEqual(r3);
    await gate(committee, false);
    await rpc(organizer, 'set_round_drop', { p_question: committee, p_rule: 'count', p_n: 1 });
    const tie = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(tie.needs).toBe('tie_break');
    expect(tie.tied!.map((t) => t.label).sort()).toEqual(['P11', 'P12']);
    const a = await rpc(organizer, 'settle_round', { p_question: committee, p_tie_drop: [ids[committee]!.P12] });
    expect(a.message).toBe('Round 4 is ready with 4 candidates.');
  }, 60000);

  test('round 4: four majorities for three seats; the chair breaks the tie on the last seat', async () => {
    await gate(committee, true);
    const r4 = { P08: 32, P09: 30, P10: 28, P11: 28 };
    await roomVotes(committee, ballotsFor(r4, 3));
    expect(await counts(committee)).toEqual(r4);
    await gate(committee, false);
    const tie = await rpc(organizer, 'settle_round', { p_question: committee });
    expect(tie.needs).toBe('seat_tie');
    expect(tie.elect_from_tie).toBe(1);
    const a = await rpc(organizer, 'settle_round', { p_question: committee, p_seat_tie: [ids[committee]!.P10] });
    expect(a.message).toBe('All 10 seats are filled.');
    expect(await seated(committee)).toEqual(
      ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10']);
    expect((await race(committee)).phase).toBe('decided');
  }, 60000);

  test('the results show the committee in seat order, and each round\'s rule', async () => {
    const r = await rpc<{ questions: Array<{ id: string; tally: { elected: Array<{ label: string; round: number }>; rounds: Array<{ round: number; drop_rule: string | null; seats_open: number }> } }> }>(
      anonClient(), 'ballot_results', { p_ballot: ballotId });
    const c = r.questions.find((q) => q.id === committee)!.tally;
    expect(c.elected.map((e) => `${e.label}@${e.round}`)).toEqual([
      'P01@1', 'P02@1', 'P03@1', 'P04@1', 'P05@1', 'P06@2', 'P07@2', 'P08@4', 'P09@4', 'P10@4']);
    expect(c.rounds.map((x) => `${x.round}:${x.seats_open}:${x.drop_rule ?? '-'}`)).toEqual(
      ['0:10:-', '1:10:votes', '2:5:count', '3:3:count', '4:3:-']);
  }, 30000);
});
