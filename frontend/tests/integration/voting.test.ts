/**
 * The whole system, against the real database.
 *
 * The suite builds a throwaway ballot as the organizer, runs a small meeting
 * through it as anonymous voters, and checks both what the rules allow and
 * what they refuse. It uses the publishable key for both roles, so anything
 * it manages to do here, a browser could do too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, organizerClient, uniqueSlug } from '../helpers/env';

let organizer: SupabaseClient;
let voter: SupabaseClient;
let ballotId: string;
let orgId: string;
let motionId: string;
let chairId: string;
let committeeId: string;
let chairOptions: Array<{ id: string; label: string }> = [];
let committeeOptions: Array<{ id: string; label: string }> = [];
let pins: string[] = [];

const call = async <T>(client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
};

type Answer = { ok: boolean; error?: string; state?: unknown; message?: string };

beforeAll(async () => {
  organizer = await organizerClient();
  voter = anonClient();

  const { data: user } = await organizer.auth.getUser();
  const ownerId = user.user!.id;

  const { data: existing } = await organizer
    .from('organizations').select('id').eq('owner_id', ownerId).limit(1).maybeSingle();

  if (existing) {
    orgId = existing.id;
  } else {
    const { data, error } = await organizer.from('organizations')
      .insert({ owner_id: ownerId, slug: uniqueSlug('test-org'), name: 'Integration Test Org' })
      .select('id').single();
    if (error) throw new Error(error.message);
    orgId = data.id;
  }

  const { data: ballot, error: ballotError } = await organizer.from('ballots')
    .insert({
      org_id: orgId, slug: uniqueSlug('run'), title: 'Integration Run',
      description: 'Created and destroyed by the test suite.',
      status: 'live', mode: 'gated', allow_vote_change: true, results_public: true,
    })
    .select('id').single();
  if (ballotError) throw new Error(ballotError.message);
  ballotId = ballot.id;

  const { data: motion } = await organizer.from('questions_yes_no')
    .insert({ ballot_id: ballotId, prompt: 'Adopt the budget', sort_order: 1, allow_abstain: true })
    .select('id').single();
  motionId = motion!.id;

  const { data: chair } = await organizer.from('questions_highest_outright')
    .insert({ ballot_id: ballotId, prompt: 'Elect the chair', sort_order: 2, allow_abstain: true })
    .select('id').single();
  chairId = chair!.id;

  const { data: committee } = await organizer.from('questions_highest_x')
    .insert({
      ballot_id: ballotId, prompt: 'Elect two members', sort_order: 3,
      select_min: 1, select_max: 2, winner_count: 2,
    })
    .select('id').single();
  committeeId = committee!.id;

  const { data: co } = await organizer.from('options_highest_outright')
    .insert(['Ann', 'Ben', 'Cara'].map((label, i) => ({ question_id: chairId, label, sort_order: i })))
    .select('id, label');
  chairOptions = co!;

  const { data: mo } = await organizer.from('options_highest_x')
    .insert(['Dan', 'Eve', 'Femi', 'Gina'].map((label, i) => ({ question_id: committeeId, label, sort_order: i })))
    .select('id, label');
  committeeOptions = mo!;

  const issued = await call<Array<{ pin: string }>>(organizer, 'issue_tokens', {
    p_ballot: ballotId, p_count: 4, p_label_prefix: 'Voter',
  });
  pins = issued.map((t) => t.pin);
  expect(pins).toHaveLength(4);
});

afterAll(async () => {
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
});

const option = (list: Array<{ id: string; label: string }>, label: string) =>
  list.find((o) => o.label === label)!.id;

const state = (pin: string, fp = 'test-fp') =>
  call<Answer & { questions?: Array<{ id: string; voted: boolean }>; progress?: { voted: number; total: number } }>(
    voter, 'voter_state', { p_ballot: ballotId, p_pin: pin, p_fingerprint: fp });

/* ------------------------------------------------------------------------ */

describe('a PIN', () => {
  test('is refused when it is not on this ballot', async () => {
    const answer = await state('000000', 'fp-wrong');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('not valid');
  });

  test('is refused when it is the wrong length', async () => {
    const answer = await state('12', 'fp-short');
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe('A PIN is six digits.');
  });

  test('opens the ballot when it is genuine', async () => {
    const answer = await state(pins[0]!, 'fp-0');
    expect(answer.ok).toBe(true);
    expect(answer.progress!.total).toBe(3);
  });

  test('is refused once the organizer disables it', async () => {
    await organizer.from('ballot_tokens')
      .update({ status: 'disabled' }).eq('ballot_id', ballotId).eq('pin', pins[3]!);
    const answer = await state(pins[3]!, 'fp-3');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('disabled');
    await organizer.from('ballot_tokens')
      .update({ status: 'active' }).eq('ballot_id', ballotId).eq('pin', pins[3]!);
  });
});

describe('the gate', () => {
  test('hides every question while it is closed', async () => {
    const answer = await state(pins[0]!, 'fp-0');
    expect(answer.questions).toHaveLength(0);
  });

  test('refuses a vote submitted against a closed gate', async () => {
    const answer = await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: motionId,
      p_choice: 'yes', p_fingerprint: 'fp-0',
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('not open');
  });

  test('reveals exactly the question the chair opens', async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
    const answer = await state(pins[0]!, 'fp-0');
    expect(answer.questions).toHaveLength(1);
    expect(answer.questions![0]!.id).toBe(motionId);
  });
});

describe('a motion', () => {
  test('records three for, one against, one abstention', async () => {
    const answers = await Promise.all([
      ['yes', pins[0]!], ['yes', pins[1]!], ['no', pins[2]!], ['abstain', pins[3]!],
    ].map(([choice, pin], i) => call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pin, p_question: motionId,
      p_choice: choice, p_fingerprint: `fp-${i}`,
    })));
    for (const a of answers) expect(a.ok).toBe(true);

    const tally = await call<{ questions: Array<{ id: string; tally: Record<string, unknown> }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const motion = tally.questions.find((q) => q.id === motionId)!.tally as {
      yes: number; no: number; abstain: number; decisive: number; carried: boolean;
    };
    expect(motion).toMatchObject({ yes: 2, no: 1, abstain: 1, decisive: 3, carried: true });
  });

  test('leaves the abstention out of the threshold', async () => {
    const tally = await call<{ questions: Array<{ id: string; tally: { cast: number; decisive: number } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const motion = tally.questions.find((q) => q.id === motionId)!.tally;
    expect(motion.cast).toBe(4);
    expect(motion.decisive).toBe(3);
  });

  test('replaces an earlier answer rather than adding to it', async () => {
    const answer = await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: motionId,
      p_choice: 'no', p_fingerprint: 'fp-0',
    });
    expect(answer.ok).toBe(true);

    const tally = await call<{ questions: Array<{ id: string; tally: { yes: number; no: number; cast: number } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const motion = tally.questions.find((q) => q.id === motionId)!.tally;
    expect(motion).toMatchObject({ yes: 1, no: 2, cast: 4 });
  });

  test('refuses a second answer when the ballot forbids changes', async () => {
    await organizer.from('ballots').update({ allow_vote_change: false }).eq('id', ballotId);
    const answer = await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: motionId,
      p_choice: 'yes', p_fingerprint: 'fp-0',
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('already voted');
    await organizer.from('ballots').update({ allow_vote_change: true }).eq('id', ballotId);
  });
});

describe('an outright election', () => {
  beforeAll(async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'highest_outright', p_question: chairId, p_open: true, p_only: true,
    });
  });

  test('elects the option with the most votes', async () => {
    await Promise.all([
      [pins[0]!, 'Ann'], [pins[1]!, 'Ann'], [pins[2]!, 'Ben'],
    ].map(([pin, label], i) => call<Answer>(voter, 'cast_highest_outright', {
      p_ballot: ballotId, p_pin: pin, p_question: chairId,
      p_option: option(chairOptions, label!), p_abstain: false, p_fingerprint: `fp-${i}`,
    })));

    const results = await call<{ questions: Array<{ id: string; tally: { winner: string; tied: boolean } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const chair = results.questions.find((q) => q.id === chairId)!.tally;
    expect(chair.winner).toBe(option(chairOptions, 'Ann'));
    expect(chair.tied).toBe(false);
  });

  test('reports no winner when a required majority is missed', async () => {
    await organizer.from('questions_highest_outright')
      .update({ require_majority: true }).eq('id', chairId);
    await call<Answer>(voter, 'cast_highest_outright', {
      p_ballot: ballotId, p_pin: pins[3]!, p_question: chairId,
      p_option: option(chairOptions, 'Cara'), p_abstain: false, p_fingerprint: 'fp-3',
    });

    const results = await call<{ questions: Array<{ id: string; tally: { winner: string | null; majority_reached: boolean } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const chair = results.questions.find((q) => q.id === chairId)!.tally;
    expect(chair.majority_reached).toBe(false);
    expect(chair.winner).toBeNull();
    await organizer.from('questions_highest_outright')
      .update({ require_majority: false }).eq('id', chairId);
  });

  test('keeps an abstention out of the count', async () => {
    await call<Answer>(voter, 'cast_highest_outright', {
      p_ballot: ballotId, p_pin: pins[3]!, p_question: chairId,
      p_option: null, p_abstain: true, p_fingerprint: 'fp-3',
    });
    const results = await call<{ questions: Array<{ id: string; tally: { total: number; abstain: number } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const chair = results.questions.find((q) => q.id === chairId)!.tally;
    expect(chair.total).toBe(3);
    expect(chair.abstain).toBe(1);
  });
});

describe('an X-of-N election', () => {
  beforeAll(async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'highest_x', p_question: committeeId, p_open: true, p_only: true,
    });
  });

  test('refuses more picks than the question allows', async () => {
    const answer = await call<Answer>(voter, 'cast_highest_x', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: committeeId,
      p_options: committeeOptions.map((o) => o.id), p_fingerprint: 'fp-0',
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('at most 2');
  });

  test('refuses an empty ballot', async () => {
    const answer = await call<Answer>(voter, 'cast_highest_x', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: committeeId,
      p_options: [], p_fingerprint: 'fp-0',
    });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('at least 1');
  });

  test('elects the top two', async () => {
    await Promise.all([
      [pins[0]!, ['Dan', 'Eve']], [pins[1]!, ['Dan', 'Femi']], [pins[2]!, ['Dan', 'Eve']],
    ].map(([pin, labels], i) => call<Answer>(voter, 'cast_highest_x', {
      p_ballot: ballotId, p_pin: pin as string, p_question: committeeId,
      p_options: (labels as string[]).map((l) => option(committeeOptions, l)),
      p_fingerprint: `fp-${i}`,
    })));

    const results = await call<{ questions: Array<{ id: string; tally: { winners: string[]; tied_at_cut: boolean; voters: number } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const committee = results.questions.find((q) => q.id === committeeId)!.tally;
    expect(committee.voters).toBe(3);
    expect(committee.winners).toEqual([
      option(committeeOptions, 'Dan'),
      option(committeeOptions, 'Eve'),
    ]);
    expect(committee.tied_at_cut).toBe(false);
  });

  test('flags a tie at the cut-off instead of breaking it', async () => {
    // Femi now matches Eve on two votes, for two seats.
    await call<Answer>(voter, 'cast_highest_x', {
      p_ballot: ballotId, p_pin: pins[3]!, p_question: committeeId,
      p_options: [option(committeeOptions, 'Femi'), option(committeeOptions, 'Gina')],
      p_fingerprint: 'fp-3',
    });
    const results = await call<{ questions: Array<{ id: string; tally: { tied_at_cut: boolean } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    const committee = results.questions.find((q) => q.id === committeeId)!.tally;
    expect(committee.tied_at_cut).toBe(true);
  });
});

describe('what a voter cannot reach', () => {
  test('the PIN list', async () => {
    const { data, error } = await voter.from('ballot_tokens').select('pin').eq('ballot_id', ballotId);
    expect(error ?? data).toBeTruthy();
    expect(data ?? []).toHaveLength(0);
  });

  test('a direct write to the ballot box', async () => {
    const { error } = await voter.from('votes_yes_no').insert({
      question_id: motionId, ballot_id: ballotId, voter_key: 'forged',
      submission_id: crypto.randomUUID(), choice: 'yes',
    });
    expect(error).not.toBeNull();
  });

  test('minting itself a PIN', async () => {
    const { error } = await voter.rpc('issue_tokens', {
      p_ballot: ballotId, p_count: 1, p_label_prefix: null,
    });
    expect(error).not.toBeNull();
  });

  test('opening a gate', async () => {
    const { error } = await voter.rpc('set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: false,
    });
    expect(error).not.toBeNull();
  });
});

describe('the organizer', () => {
  test('can void one voter\'s ballot', async () => {
    const { data: token } = await organizer.from('ballot_tokens')
      .select('id').eq('ballot_id', ballotId).eq('pin', pins[0]!).single();
    const result = await call<{ ok: boolean; voided: number }>(organizer, 'reset_token', {
      p_token: token!.id, p_question: null,
    });
    expect(result.ok).toBe(true);
    expect(result.voided).toBeGreaterThan(0);

    const answer = await state(pins[0]!, 'fp-0');
    expect(answer.progress!.voted).toBe(0);
  });

  test('can void the whole ballot', async () => {
    const result = await call<{ ok: boolean }>(organizer, 'clear_ballot_votes', { p_ballot: ballotId });
    expect(result.ok).toBe(true);

    const results = await call<{ questions: Array<{ tally: { voters?: number; cast?: number } }> }>(
      voter, 'ballot_results', { p_ballot: ballotId });
    for (const q of results.questions) {
      expect(q.tally.voters ?? 0).toBe(0);
    }
  });

  test('cannot switch anonymity once a vote exists', async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
    await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: motionId, p_choice: 'yes', p_fingerprint: 'fp-0',
    });
    const { error } = await organizer.from('ballots').update({ anonymous: false }).eq('id', ballotId);
    expect(error?.message ?? '').toContain('Anonymity cannot be changed');
  });
});

describe('a draft ballot', () => {
  test('is invisible to a voter until it is published', async () => {
    await organizer.from('ballots').update({ status: 'draft' }).eq('id', ballotId);
    const answer = await state(pins[0]!, 'fp-0');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('not been published');

    const { data } = await voter.from('ballots').select('id').eq('id', ballotId).maybeSingle();
    expect(data).toBeNull();

    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
  });
});
