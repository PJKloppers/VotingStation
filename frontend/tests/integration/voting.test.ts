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
import { anonClient, organizerClient, otherOrganizerClient, uniqueSlug } from '../helpers/env';

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
    p_ballot: ballotId, p_count: 4,
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
      organizer, 'ballot_results', { p_ballot: ballotId });
    const motion = tally.questions.find((q) => q.id === motionId)!.tally as {
      yes: number; no: number; abstain: number; decisive: number; carried: boolean;
    };
    expect(motion).toMatchObject({ yes: 2, no: 1, abstain: 1, decisive: 3, carried: true });
  });

  test('leaves the abstention out of the threshold', async () => {
    const tally = await call<{ questions: Array<{ id: string; tally: { cast: number; decisive: number } }> }>(
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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
      p_ballot: ballotId, p_count: 1,
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
      organizer, 'ballot_results', { p_ballot: ballotId });
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

/* ------------------------------------------------------------------------ */

describe('creating a ballot', () => {
  // A ballot is born a draft, so this is the first thing the organizer's
  // "New ballot" button does. It used to be refused outright: the read policy
  // looked the new row up in `ballots`, where an INSERT cannot yet see it.
  test('a draft comes back from the insert that made it', async () => {
    const { data, error } = await organizer.from('ballots')
      .insert({ org_id: orgId, slug: uniqueSlug('fresh'), title: 'Fresh draft' })
      .select('id, status').single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.status).toBe('draft');
    await organizer.from('ballots').delete().eq('id', data!.id);
  });

  test('a draft is the organizer\'s alone until they publish it', async () => {
    const { data } = await organizer.from('ballots')
      .insert({ org_id: orgId, slug: uniqueSlug('hidden'), title: 'Hidden draft' })
      .select('id').single();

    const { data: seen } = await voter.from('ballots').select('id').eq('id', data!.id).maybeSingle();
    expect(seen).toBeNull();

    const { data: mine } = await organizer.from('ballots').select('id').eq('id', data!.id).maybeSingle();
    expect(mine?.id).toBe(data!.id);

    await organizer.from('ballots').delete().eq('id', data!.id);
  });
});

describe('one account cannot see another\'s', () => {
  // The dashboard lists whatever row level security hands it, so the policy is
  // the whole boundary. These read the tables directly rather than through a
  // client-side filter, which would hide a policy that had loosened again.
  let other: SupabaseClient;
  let otherId = '';
  let otherOrg = '';
  let otherBallot = '';

  beforeAll(async () => {
    other = await otherOrganizerClient();
    const { data: u } = await other.auth.getUser();
    otherId = u.user!.id;

    const { data: existing } = await other.from('organizations')
      .select('id').eq('owner_id', otherId).limit(1).maybeSingle();

    otherOrg = existing?.id ?? (await other.from('organizations')
      .insert({ owner_id: otherId, slug: uniqueSlug('other-org'), name: 'Someone Else' })
      .select('id').single()).data!.id;

    const { data: b } = await other.from('ballots').insert({
      org_id: otherOrg, slug: uniqueSlug('theirs'), title: 'Their private ballot',
    }).select('id').single();
    otherBallot = b!.id;
  });

  afterAll(async () => {
    if (otherBallot) await other.from('ballots').delete().eq('id', otherBallot);
    await other.auth.signOut();
  });

  test('their organizations are invisible', async () => {
    const { data } = await organizer.from('organizations').select('id, owner_id');
    const theirs = (data ?? []).filter((o) => o.owner_id !== null && o.owner_id !== undefined
      && o.id === otherOrg);
    expect(theirs).toHaveLength(0);
  });

  test('and the list a dashboard gets holds only your own', async () => {
    const { data: mine } = await organizer.auth.getUser();
    const { data } = await organizer.from('organizations').select('id, owner_id');
    expect(data!.length).toBeGreaterThan(0);
    for (const o of data!) expect(o.owner_id).toBe(mine.user!.id);
  });

  test('it holds in the other direction too', async () => {
    const { data } = await other.from('organizations').select('id, owner_id');
    for (const o of data!) expect(o.owner_id).toBe(otherId);
  });

  test('an anonymous reader sees no organizations at all', async () => {
    const { data } = await voter.from('organizations').select('id');
    expect(data ?? []).toHaveLength(0);
  });

  test('their draft ballot is invisible', async () => {
    const { data } = await organizer.from('ballots').select('id').eq('id', otherBallot).maybeSingle();
    expect(data).toBeNull();
  });

  test('renaming their organization changes nothing', async () => {
    // It never could -- the write policies were always owner-scoped. PostgREST
    // reports no error when row level security simply matches nothing, so the
    // check has to be whether the row moved, not whether the call complained.
    await organizer.from('organizations').update({ name: 'Taken over' }).eq('id', otherOrg);

    const { data } = await other.from('organizations').select('name').eq('id', otherOrg).single();
    expect(data!.name).not.toBe('Taken over');
  });

  test('nor can they mint PINs on it, or step its ballot', async () => {
    const minted = await organizer.rpc('issue_tokens', { p_ballot: otherBallot, p_count: 1 });
    expect(minted.error).not.toBeNull();

    const stepped = await organizer.rpc('advance_ballot', { p_ballot: otherBallot });
    expect(stepped.error).not.toBeNull();
  });
});

describe('an organization\'s mark', () => {
  // The bucket is public to read, so the boundary that matters is who can write
  // into whose folder, and who can read the table that says which object is
  // whose. The table is owner-only; a voter gets the path from the functions
  // they already call.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  let mine = '';
  let theirs: SupabaseClient;
  let theirOrg = '';
  let path = '';

  beforeAll(async () => {
    mine = orgId;
    theirs = await otherOrganizerClient();
    const { data: u } = await theirs.auth.getUser();
    const { data: org } = await theirs.from('organizations')
      .select('id').eq('owner_id', u.user!.id).limit(1).maybeSingle();
    theirOrg = org?.id ?? (await theirs.from('organizations')
      .insert({ owner_id: u.user!.id, slug: uniqueSlug('mark-org'), name: 'Mark Org' })
      .select('id').single()).data!.id;
  });

  afterAll(async () => {
    if (path) {
      await organizer.from('organization_images').delete().eq('org_id', mine).eq('kind', 'logo');
      await organizer.storage.from('org-logos').remove([path]);
    }
    await theirs.auth.signOut();
  });

  test('the owner can put one in their own folder', async () => {
    path = `${mine}/${crypto.randomUUID()}.png`;
    const { error } = await organizer.storage.from('org-logos')
      .upload(path, png, { contentType: 'image/png' });
    expect(error).toBeNull();

    const { error: rowErr } = await organizer.from('organization_images')
      .upsert({ org_id: mine, kind: 'logo', bucket: 'org-logos', path,
                content_type: 'image/png', bytes: png.length },
              { onConflict: 'org_id,kind' });
    expect(rowErr).toBeNull();
  });

  test('but not into somebody else\'s', async () => {
    const { error } = await organizer.storage.from('org-logos')
      .upload(`${theirOrg}/${crypto.randomUUID()}.png`, png, { contentType: 'image/png' });
    expect(error).not.toBeNull();
  });

  test('nor claim one for their organization', async () => {
    const { error } = await organizer.from('organization_images')
      .insert({ org_id: theirOrg, kind: 'logo', bucket: 'org-logos', path: 'x/y.png' });
    expect(error).not.toBeNull();
  });

  test('the table is invisible to a voter', async () => {
    const { data } = await voter.from('organization_images').select('id');
    expect(data ?? []).toHaveLength(0);
  });

  test('and invisible to another organizer', async () => {
    const { data } = await theirs.from('organization_images').select('org_id');
    for (const row of data ?? []) expect(row.org_id).toBe(theirOrg);
  });

  test('a voter gets the path for a published ballot all the same', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
    await organizer.rpc('renew_ballot', { p_ballot: ballotId });

    const { data } = await voter.rpc('ballot_logo', { p_ballot: ballotId });
    expect(data).toBe(path);
  });

  test('but not for a draft one', async () => {
    await organizer.from('ballots').update({ status: 'draft' }).eq('id', ballotId);
    const { data } = await voter.rpc('ballot_logo', { p_ballot: ballotId });
    expect(data).toBeNull();
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
  });

  test('it rides along with the waiting screen and the tally', async () => {
    const lobby = await state(pins[1]!, 'fp-mark');
    expect((lobby as unknown as { ballot: { org_logo_path: string } }).ballot.org_logo_path)
      .toBe(path);

    const results = await call<{ ballot: { org_logo_path: string } }>(
      organizer, 'ballot_results', { p_ballot: ballotId });
    expect(results.ballot.org_logo_path).toBe(path);
  });

  test('removing the row leaves nothing for a voter to fetch', async () => {
    await organizer.from('organization_images').delete().eq('org_id', mine).eq('kind', 'logo');
    const { data } = await voter.rpc('ballot_logo', { p_ballot: ballotId });
    expect(data).toBeNull();

    // put it back for the teardown to clear
    await organizer.from('organization_images')
      .insert({ org_id: mine, kind: 'logo', bucket: 'org-logos', path,
                content_type: 'image/png', bytes: png.length });
  });
});

describe('a ballot has a lifetime', () => {
  test('it is born with thirty days on the clock', async () => {
    const { data } = await organizer.from('ballots')
      .select('id, created_at, expires_at')
      .eq('id', ballotId).single();

    const days = (new Date(data!.expires_at).getTime()
                - new Date(data!.created_at).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  test('a voter is turned away the moment it expires, purge or no purge', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);

    // An owner may bring the expiry forward, never push it past the window.
    await organizer.rpc('set_ballot_expiry', {
      p_ballot: ballotId, p_when: new Date(Date.now() - 1000).toISOString(),
    });
    const dead = await state(pins[1]!, 'fp-expiry');
    expect(dead.ok).toBe(false);
    expect((dead as { error: string }).error).toContain('expired');

    await organizer.rpc('renew_ballot', { p_ballot: ballotId });
    const live = await state(pins[1]!, 'fp-expiry');
    expect(live.ok).toBe(true);
  });

  test('an owner cannot push the expiry past the retention window', async () => {
    const { data } = await organizer.rpc('set_ballot_expiry', {
      p_ballot: ballotId,
      p_when: new Date(Date.now() + 400 * 86_400_000).toISOString(),
    });
    expect((data as { ok: boolean }).ok).toBe(false);
    expect((data as { error: string }).error).toContain('may not outlive');
  });

  test('renewing pushes the clock out from now', async () => {
    const before = (await organizer.from('ballots')
      .select('expires_at').eq('id', ballotId).single()).data!.expires_at;

    const { data } = await organizer.rpc('renew_ballot', { p_ballot: ballotId });
    const after = (data as { expires_at: string }).expires_at;

    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(after).getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
  });

  test('nobody but the owner can renew one', async () => {
    const { error } = await voter.rpc('renew_ballot', { p_ballot: ballotId });
    expect(error).not.toBeNull();
  });

  test('a client cannot write the expiry directly', async () => {
    const { error } = await organizer.from('ballots')
      .update({ expires_at: '2099-01-01T00:00:00Z' }).eq('id', ballotId);
    expect(error).not.toBeNull();
  });

  test('the purge takes an expired ballot and leaves the rest', async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations')
      .select('id').eq('owner_id', user.user!.id).limit(1).single();

    const { data: doomed } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('expired'), title: 'Past it', status: 'live',
    }).select('id').single();

    const wound = await organizer.rpc('set_ballot_expiry', {
      p_ballot: doomed!.id, p_when: new Date(Date.now() - 1000).toISOString(),
    });
    expect((wound.data as { ok: boolean }).ok).toBe(true);

    const purged = await organizer.rpc('purge_expired_ballots');
    expect((purged.data as { ballots: number }).ballots).toBeGreaterThanOrEqual(1);

    const { data: gone } = await organizer.from('ballots')
      .select('id').eq('id', doomed!.id).maybeSingle();
    expect(gone).toBeNull();

    const { data: kept } = await organizer.from('ballots')
      .select('id').eq('id', ballotId).maybeSingle();
    expect(kept).not.toBeNull();
  });
});

describe('quotas', () => {
  test('an organization holds at most twenty ballots', async () => {
    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations').insert({
      owner_id: user.user!.id, slug: uniqueSlug('quota'), name: 'Quota Org',
    }).select('id').single();

    const rows = Array.from({ length: 20 }, (_, i) => ({
      org_id: org!.id, slug: uniqueSlug(`q${i}`), title: `Ballot ${i}`,
    }));
    const { error: bulk } = await organizer.from('ballots').insert(rows);
    expect(bulk).toBeNull();

    const { error: overflow } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('one-too-many'), title: 'One too many',
    });
    expect(overflow?.message ?? '').toContain('at most 20 ballots');

    await organizer.from('organizations').delete().eq('id', org!.id);
  });

  test('a user holds at most five organizations', async () => {
    const { data: user } = await organizer.auth.getUser();
    const ownerId = user.user!.id;

    const { count: held } = await organizer.from('organizations')
      .select('id', { count: 'exact', head: true }).eq('owner_id', ownerId);

    const room = 5 - (held ?? 0);
    const made: string[] = [];
    for (let i = 0; i < room; i++) {
      const { data } = await organizer.from('organizations')
        .insert({ owner_id: ownerId, slug: uniqueSlug(`orgq${i}`), name: `Quota ${i}` })
        .select('id').single();
      made.push(data!.id);
    }

    const { error } = await organizer.from('organizations')
      .insert({ owner_id: ownerId, slug: uniqueSlug('sixth'), name: 'Sixth' });
    expect(error?.message ?? '').toContain('at most 5 organizations');

    for (const id of made) await organizer.from('organizations').delete().eq('id', id);
  });
});

describe('the chair steps through the ballot', () => {
  type Step = { ok: boolean; action?: string; opened?: { id: string }; closed?: { id: string } };
  const advance = () => call<Step>(organizer, 'advance_ballot', { p_ballot: ballotId });
  const openNow = async () => {
    const { data } = await organizer.from('ballot_questions')
      .select('id, prompt, sort_order').eq('ballot_id', ballotId).eq('gate_open', true);
    return (data ?? []).map((q) => q.id as string);
  };

  beforeAll(async () => {
    await organizer.from('ballots')
      .update({ status: 'live', mode: 'gated' }).eq('id', ballotId);
    await organizer.rpc('renew_ballot', { p_ballot: ballotId });
    await call(organizer, 'close_all_gates', { p_ballot: ballotId });
  });

  test('the first step opens the first question and nothing else', async () => {
    const step = await advance();
    expect(step.ok).toBe(true);
    expect(step.action).toBe('opened');
    expect(step.opened!.id).toBe(motionId);
    expect(await openNow()).toEqual([motionId]);
  });

  test('each step closes one and opens exactly the next', async () => {
    const second = await advance();
    expect(second.action).toBe('advanced');
    expect(second.closed!.id).toBe(motionId);
    expect(second.opened!.id).toBe(chairId);
    expect(await openNow()).toEqual([chairId]);

    const third = await advance();
    expect(third.action).toBe('advanced');
    expect(third.opened!.id).toBe(committeeId);
    expect(await openNow()).toEqual([committeeId]);
  });

  test('the last step closes the ballot instead of opening anything', async () => {
    const last = await advance();
    expect(last.action).toBe('finished');
    expect(last.closed!.id).toBe(committeeId);
    expect(await openNow()).toEqual([]);

    const { data } = await organizer.from('ballots')
      .select('status').eq('id', ballotId).single();
    expect(data!.status).toBe('closed');
  });

  test('a voter can no longer reach it once that has happened', async () => {
    const answer = await state(pins[1]!, 'fp-stepped');
    expect(answer.ok).toBe(false);
  });

  test('it never leaves two gates open, even from a messy start', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: false,
    });
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'highest_x', p_question: committeeId, p_open: true, p_only: false,
    });
    expect((await openNow()).length).toBe(2);

    const step = await advance();
    expect(step.ok).toBe(true);
    expect((await openNow()).length).toBeLessThanOrEqual(1);
  });

  test('nobody but the owner may step it', async () => {
    const { error } = await voter.rpc('advance_ballot', { p_ballot: ballotId });
    expect(error).not.toBeNull();
  });
});

describe('deleting a PIN', () => {
  // Its own ballot: minting PINs on the shared one would change what every
  // later test is counting.
  let scratchBallot = '';
  let scratchQuestion = '';

  const pinsOn = async (n: number) =>
    call<Array<{ pin: string }>>(organizer, 'issue_tokens', {
      p_ballot: scratchBallot, p_count: n,
    });

  const castOn = (pin: string, choice: 'yes' | 'no') =>
    call<Answer>(voter, 'cast_yes_no', {
      p_ballot: scratchBallot, p_pin: pin, p_question: scratchQuestion,
      p_choice: choice, p_fingerprint: `fp-${pin}`,
    });

  const rows = async (onlyStanding = false) => {
    let q = organizer.from('votes_yes_no')
      .select('id', { count: 'exact', head: true }).eq('ballot_id', scratchBallot);
    if (onlyStanding) q = q.eq('valid', true);
    return (await q).count ?? 0;
  };

  beforeAll(async () => {
    const { data: b } = await organizer.from('ballots').insert({
      org_id: orgId, slug: uniqueSlug('pindel'), title: 'PIN deletion',
      status: 'live', mode: 'gated', allow_vote_change: true,
    }).select('id').single();
    scratchBallot = b!.id;

    const { data: q } = await organizer.from('questions_yes_no').insert({
      ballot_id: scratchBallot, prompt: 'Carry the motion', sort_order: 1,
    }).select('id').single();
    scratchQuestion = q!.id;

    await call(organizer, 'set_gate', {
      p_ballot: scratchBallot, p_type: 'yes_no',
      p_question: scratchQuestion, p_open: true, p_only: true,
    });
  });

  afterAll(async () => {
    if (scratchBallot) await organizer.from('ballots').delete().eq('id', scratchBallot);
  });

  test('its votes go with it, not just the PIN', async () => {
    const [minted] = await pinsOn(1);
    expect((await castOn(minted!.pin, 'yes')).ok).toBe(true);
    expect(await rows()).toBe(1);

    const { data: tok } = await organizer.from('ballot_tokens')
      .select('id').eq('ballot_id', scratchBallot).eq('pin', minted!.pin).single();

    const { error } = await organizer.from('ballot_tokens').delete().eq('id', tok!.id);
    expect(error).toBeNull();

    // Not merely voided -- gone.
    expect(await rows()).toBe(0);
  });

  test('it leaves everyone else\'s votes alone', async () => {
    const minted = await pinsOn(2);
    await castOn(minted[0]!.pin, 'yes');
    await castOn(minted[1]!.pin, 'no');
    expect(await rows()).toBe(2);

    const { data: tok } = await organizer.from('ballot_tokens')
      .select('id').eq('ballot_id', scratchBallot).eq('pin', minted[0]!.pin).single();
    await organizer.from('ballot_tokens').delete().eq('id', tok!.id);

    expect(await rows()).toBe(1);
    const tally = await call<{ questions: Array<{ tally: { yes: number; no: number } }> }>(
      organizer, 'ballot_results', { p_ballot: scratchBallot });
    expect(tally.questions[0]!.tally).toMatchObject({ yes: 0, no: 1 });
  });

  test('resetting instead voids the votes and keeps the rows', async () => {
    const before = await rows();
    const [minted] = await pinsOn(1);
    await castOn(minted!.pin, 'yes');
    expect(await rows()).toBe(before + 1);

    const { data: tok } = await organizer.from('ballot_tokens')
      .select('id').eq('ballot_id', scratchBallot).eq('pin', minted!.pin).single();
    await organizer.rpc('reset_token', { p_token: tok!.id, p_question: null });

    // The row is still there, and no longer counted.
    expect(await rows()).toBe(before + 1);
    expect(await rows(true)).toBe(before);

    // And the PIN may vote again.
    expect((await castOn(minted!.pin, 'no')).ok).toBe(true);
    expect(await rows(true)).toBe(before + 1);
  });

  test('and the PIN itself survives a reset', async () => {
    const { count } = await organizer.from('ballot_tokens')
      .select('id', { count: 'exact', head: true }).eq('ballot_id', scratchBallot);
    expect(count).toBeGreaterThan(0);
  });
});

describe('disabling a PIN that has already voted', () => {
  // Disable stops a PIN voting again. It does not touch what it already cast --
  // that is what reset (void, keep the trail) and delete (remove it) are for.
  let scratch = '';
  let question = '';
  let voted = '';
  let silent = '';

  const tally = async () => {
    const r = await call<{ questions: Array<{ voted: number; expected: number; tally: { cast: number } }> }>(
      organizer, 'ballot_results', { p_ballot: scratch });
    return r.questions[0]!;
  };
  const step = () => call<{ ok: boolean; waiting?: { voted: number; eligible: number } }>(
    organizer, 'advance_ballot', { p_ballot: scratch });
  const reopen = async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', scratch);
    await call(organizer, 'set_gate', {
      p_ballot: scratch, p_type: 'yes_no', p_question: question, p_open: true, p_only: true,
    });
  };

  beforeAll(async () => {
    const { data: b } = await organizer.from('ballots').insert({
      org_id: orgId, slug: uniqueSlug('disabled'), title: 'Disable probe',
      status: 'live', mode: 'gated', require_all_pins: true,
    }).select('id').single();
    scratch = b!.id;

    const { data: q } = await organizer.from('questions_yes_no').insert({
      ballot_id: scratch, prompt: 'Carry it', sort_order: 1,
    }).select('id').single();
    question = q!.id;
    await reopen();

    const minted = await call<Array<{ pin: string }>>(organizer, 'issue_tokens', {
      p_ballot: scratch, p_count: 2,
    });
    voted = minted[0]!.pin;
    silent = minted[1]!.pin;

    await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: scratch, p_pin: voted, p_question: question,
      p_choice: 'yes', p_fingerprint: 'fp-disabled',
    });
  });

  afterAll(async () => {
    if (scratch) await organizer.from('ballots').delete().eq('id', scratch);
  });

  test('the vote it already cast is untouched', async () => {
    const before = await tally();
    expect(before.tally.cast).toBe(1);

    await organizer.from('ballot_tokens')
      .update({ status: 'disabled' }).eq('ballot_id', scratch).eq('pin', voted);

    const after = await tally();
    expect(after.tally.cast).toBe(1);
    expect(after.voted).toBe(1);
  });

  test('and it is still counted as one of the voters expected', async () => {
    // Otherwise disabling a voter would let their vote stand for the room.
    const now = await tally();
    expect(now.expected).toBe(2);
  });

  test('so the chair is still held for the PIN that has not voted', async () => {
    const held = await step();
    expect(held.ok).toBe(false);
    expect(held.waiting).toMatchObject({ voted: 1, eligible: 2 });
  });

  test('a PIN disabled before voting is not waited for', async () => {
    await organizer.from('ballot_tokens')
      .update({ status: 'disabled' }).eq('ballot_id', scratch).eq('pin', silent);

    const now = await tally();
    expect(now.expected).toBe(1);

    const moved = await step();
    expect(moved.ok).toBe(true);
  });

  test('the vote survives even the PIN being re-enabled and the ballot reopened', async () => {
    await organizer.from('ballot_tokens')
      .update({ status: 'active' }).eq('ballot_id', scratch).eq('pin', voted);
    await reopen();
    expect((await tally()).tally.cast).toBe(1);
  });
});

describe('waiting for every PIN', () => {
  type Step = { ok: boolean; error?: string; action?: string;
                waiting?: { voted: number; eligible: number } };
  const advance = () => call<Step>(organizer, 'advance_ballot', { p_ballot: ballotId });

  beforeAll(async () => {
    await organizer.from('ballots')
      .update({ status: 'live', mode: 'gated', require_all_pins: true, allow_vote_change: true })
      .eq('id', ballotId);
    await organizer.rpc('renew_ballot', { p_ballot: ballotId });
    await call(organizer, 'clear_ballot_votes', { p_ballot: ballotId });
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
  });

  afterAll(async () => {
    await organizer.from('ballots').update({ require_all_pins: false }).eq('id', ballotId);
  });

  test('the chair cannot step past a question nobody has answered', async () => {
    const step = await advance();
    expect(step.ok).toBe(false);
    expect(step.error).toContain('waits for all of them');
    expect(step.waiting!.voted).toBe(0);
    expect(step.waiting!.eligible).toBe(4);
  });

  test('nor while one PIN is still outstanding', async () => {
    for (const pin of pins.slice(0, 3)) {
      const cast = await call<Answer>(voter, 'cast_yes_no', {
        p_ballot: ballotId, p_pin: pin, p_question: motionId,
        p_choice: 'yes', p_fingerprint: `fp-all-${pin}`,
      });
      expect(cast.ok).toBe(true);
    }

    const step = await advance();
    expect(step.ok).toBe(false);
    expect(step.waiting).toMatchObject({ voted: 3, eligible: 4 });

    // and the gate is still open, so the last voter can still get in
    const { data } = await organizer.from('questions_yes_no')
      .select('gate_open').eq('id', motionId).single();
    expect(data!.gate_open).toBe(true);
  });

  test('a disabled PIN is not waited for', async () => {
    await organizer.from('ballot_tokens')
      .update({ status: 'disabled' }).eq('ballot_id', ballotId).eq('pin', pins[3]!);

    const step = await advance();
    expect(step.ok).toBe(true);
    expect(step.action).toBe('advanced');

    await organizer.from('ballot_tokens')
      .update({ status: 'active' }).eq('ballot_id', ballotId).eq('pin', pins[3]!);
  });

  test('once the last one votes, the step goes through', async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
    const blocked = await advance();
    expect(blocked.ok).toBe(false);

    const cast = await call<Answer>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[3]!, p_question: motionId,
      p_choice: 'no', p_fingerprint: 'fp-all-last',
    });
    expect(cast.ok).toBe(true);

    const step = await advance();
    expect(step.ok).toBe(true);
    expect(step.action).toBe('advanced');
  });

  test('with the setting off the chair may step whenever they like', async () => {
    await organizer.from('ballots').update({ require_all_pins: false }).eq('id', ballotId);
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'highest_x', p_question: committeeId, p_open: true, p_only: true,
    });
    const step = await advance();
    expect(step.ok).toBe(true);
    await organizer.from('ballots').update({ require_all_pins: true }).eq('id', ballotId);
  });

  test('the tally says how many PINs are being waited for', async () => {
    const results = await call<{ turnout: { issued: number; used: number; eligible: number } }>(
      organizer, 'ballot_results', { p_ballot: ballotId });
    expect(results.turnout.eligible).toBe(4);
    expect(results.turnout.issued).toBe(4);
  });
});

describe('a voter only sees a count once the question is finished', () => {
  beforeAll(async () => {
    await organizer.from('ballots')
      .update({ status: 'live', show_results_after: true, allow_vote_change: true })
      .eq('id', ballotId);
    await organizer.rpc('renew_ballot', { p_ballot: ballotId });
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });
  });

  test('the receipt carries no tally while the gate is open', async () => {
    const answer = await call<Answer & { results: unknown }>(voter, 'cast_yes_no', {
      p_ballot: ballotId, p_pin: pins[0]!, p_question: motionId,
      p_choice: 'yes', p_fingerprint: 'fp-settle',
    });
    expect(answer.ok).toBe(true);
    expect(answer.results).toBeNull();
  });

  test('and the waiting screen does not either', async () => {
    const answer = await state(pins[0]!, 'fp-settle');
    expect(answer.ok).toBe(true);
    expect((answer as unknown as { settled: unknown[] }).settled).toEqual([]);
  });

  test('closing the gate hands the voter the count', async () => {
    await call(organizer, 'close_all_gates', { p_ballot: ballotId });

    const answer = await state(pins[0]!, 'fp-settle');
    const settled = (answer as unknown as {
      settled: Array<{ id: string; tally: { yes: number } }>;
    }).settled;

    expect(settled.map((r) => r.id)).toContain(motionId);
    expect(settled.find((r) => r.id === motionId)!.tally.yes).toBeGreaterThan(0);
  });

  test('a ballot that does not show voters results shows them nothing either way', async () => {
    await organizer.from('ballots').update({ show_results_after: false }).eq('id', ballotId);
    const answer = await state(pins[0]!, 'fp-settle');
    expect((answer as unknown as { settled: unknown[] }).settled).toEqual([]);
    await organizer.from('ballots').update({ show_results_after: true }).eq('id', ballotId);
  });
});

describe('a question publishes when its own gate closes', () => {
  // Publication is per question, not per ballot: a chair closes the first
  // motion and announces it long before the last one is put.
  const asVoter = () => call<{
    ok: boolean; error?: string; withheld?: number;
    questions?: Array<{ id: string }>;
  }>(voter, 'ballot_results', { p_ballot: ballotId });

  beforeAll(async () => {
    await organizer.from('ballots')
      .update({ status: 'live', mode: 'gated', results_public: true })
      .eq('id', ballotId);
    await organizer.rpc('renew_ballot', { p_ballot: ballotId });
  });

  test('a question still taking votes is withheld', async () => {
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'yes_no', p_question: motionId, p_open: true, p_only: true,
    });

    const answer = await asVoter();
    expect(answer.ok).toBe(true);
    expect(answer.questions!.map((q) => q.id)).not.toContain(motionId);
    expect(answer.withheld).toBeGreaterThanOrEqual(1);
  });

  test('and its rows cannot be tallied by hand instead', async () => {
    const { data } = await voter.from('votes_yes_no')
      .select('id').eq('question_id', motionId);
    expect(data ?? []).toHaveLength(0);
  });

  test('closing that gate publishes it, and only it', async () => {
    // The motion closes; the election opens. One is finished, one is not.
    await call(organizer, 'set_gate', {
      p_ballot: ballotId, p_type: 'highest_outright', p_question: chairId,
      p_open: true, p_only: true,
    });

    const answer = await asVoter();
    const shown = answer.questions!.map((q) => q.id);
    expect(shown).toContain(motionId);
    expect(shown).not.toContain(chairId);
    expect(answer.withheld).toBe(1);

    const { data } = await voter.from('votes_yes_no')
      .select('id').eq('question_id', motionId);
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  test('the organizer reads every question throughout', async () => {
    const answer = await call<{ ok: boolean; withheld: number; questions: unknown[] }>(
      organizer, 'ballot_results', { p_ballot: ballotId });
    expect(answer.ok).toBe(true);
    expect(answer.withheld).toBe(0);
    expect(answer.questions.length).toBe(3);
  });

  test('closing the ballot publishes what is left', async () => {
    await organizer.from('ballots').update({ status: 'closed' }).eq('id', ballotId);
    const answer = await asVoter();
    expect(answer.withheld).toBe(0);
    expect(answer.questions!.length).toBe(3);
  });

  test('a ballot that does not publish stays private, gates or no gates', async () => {
    await organizer.from('ballots').update({ results_public: false }).eq('id', ballotId);

    const answer = await asVoter();
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('does not publish its results');

    const { data } = await voter.from('votes_yes_no').select('id').eq('ballot_id', ballotId);
    expect(data ?? []).toHaveLength(0);

    await organizer.from('ballots')
      .update({ results_public: true, status: 'live' }).eq('id', ballotId);
  });
});

describe('PINs carry no label', () => {
  test('the report hands back a PIN and its state, and nothing else about it', async () => {
    const report = await call<{ tokens: Array<Record<string, unknown>> }>(
      organizer, 'ballot_token_report', { p_ballot: ballotId });
    expect(report.tokens.length).toBeGreaterThan(0);
    expect(report.tokens[0]).not.toHaveProperty('label');
  });

  test('the lobby no longer greets a voter by one', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
    const answer = await state(pins[1]!, 'fp-nolabel');
    expect(answer.ok).toBe(true);
    expect((answer as unknown as { voter: Record<string, unknown> }).voter)
      .not.toHaveProperty('label');
  });

  test('the column is gone, not merely unused', async () => {
    const { error } = await organizer.from('ballot_tokens')
      .select('label').eq('ballot_id', ballotId);
    expect(error).not.toBeNull();
  });

  test('issuing takes a count and nothing else', async () => {
    const { error } = await organizer.rpc('issue_tokens', {
      p_ballot: ballotId, p_count: 1, p_label_prefix: 'Delegate',
    });
    expect(error).not.toBeNull();
  });
});

describe('finding a ballot from a PIN alone', () => {
  const lookup = (pin: string, fp: string) =>
    call<{ ok: boolean; error?: string; ballots?: Array<{ ballot_id: string; org_name: string }> }>(
      voter, 'find_ballots_for_pin', { p_pin: pin, p_fingerprint: fp });

  test('names the ballot a real PIN opens', async () => {
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
    const answer = await lookup(pins[1]!, 'fp-lookup');
    expect(answer.ok).toBe(true);
    expect(answer.ballots!.map((b) => b.ballot_id)).toContain(ballotId);
  });

  test('carries the organization, so a chooser can be labelled', async () => {
    const answer = await lookup(pins[1]!, 'fp-lookup');
    const mine = answer.ballots!.find((b) => b.ballot_id === ballotId)!;
    expect(mine.org_name.length).toBeGreaterThan(0);
  });

  test('refuses a PIN that opens nothing', async () => {
    const answer = await lookup('000000', 'fp-lookup-miss');
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('not valid');
  });

  test('refuses a PIN of the wrong length without counting it', async () => {
    const answer = await lookup('12', 'fp-lookup-short');
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe('A PIN is six digits.');
  });

  test('will not point at a draft ballot', async () => {
    await organizer.from('ballots').update({ status: 'draft' }).eq('id', ballotId);
    const answer = await lookup(pins[1]!, 'fp-lookup-draft');
    expect(answer.ok).toBe(false);
    await organizer.from('ballots').update({ status: 'live' }).eq('id', ballotId);
  });

  test('returns every ballot a PIN happens to open', async () => {
    // The same six digits, minted by hand on a second ballot.
    const { data: other } = await organizer.from('ballots').insert({
      org_id: orgId, slug: uniqueSlug('twin'), title: 'Twin Ballot', status: 'live',
    }).select('id').single();
    await organizer.from('ballot_tokens')
      .insert({ ballot_id: other!.id, pin: pins[1]! });

    const answer = await lookup(pins[1]!, 'fp-lookup-twin');
    expect(answer.ok).toBe(true);
    expect(answer.ballots!.map((b) => b.ballot_id).sort())
      .toEqual([ballotId, other!.id].sort());

    await organizer.from('ballots').delete().eq('id', other!.id);
  });

  test('locks a browser out after twelve misses, and only misses count', async () => {
    const fp = `fp-brute-${Date.now()}`;
    for (let i = 0; i < 12; i++) {
      const miss = await lookup(String(100000 + i), fp);
      expect(miss.ok).toBe(false);
    }
    const locked = await lookup(pins[1]!, fp);
    expect(locked.ok).toBe(false);
    expect(locked.error).toContain('Too many incorrect PINs');

    // A browser that has not been guessing is unaffected.
    const innocent = await lookup(pins[1]!, `fp-clean-${Date.now()}`);
    expect(innocent.ok).toBe(true);
  });

  test('is not reachable as a table, only as that function', async () => {
    const { error } = await voter.from('pin_lookups').select('fingerprint');
    expect(error).not.toBeNull();
  });
});

describe('the quotas are the database\'s own numbers', () => {
  test('a client can read them without reaching into the app schema', async () => {
    const limits = await call<{ organizations_per_user: number; ballots_per_organization: number }>(
      voter, 'app_limits', {});
    expect(limits.organizations_per_user).toBe(5);
    expect(limits.ballots_per_organization).toBe(20);
  });

  test('and they are the same numbers the triggers refuse on', async () => {
    const limits = await call<{ ballots_per_organization: number }>(voter, 'app_limits', {});

    const { data: user } = await organizer.auth.getUser();
    const { data: org } = await organizer.from('organizations').insert({
      owner_id: user.user!.id, slug: uniqueSlug('limitcheck'), name: 'Limit check',
    }).select('id').single();

    const rows = Array.from({ length: limits.ballots_per_organization }, (_, i) => ({
      org_id: org!.id, slug: uniqueSlug(`l${i}`), title: `Ballot ${i}`,
    }));
    expect((await organizer.from('ballots').insert(rows)).error).toBeNull();

    const { error } = await organizer.from('ballots').insert({
      org_id: org!.id, slug: uniqueSlug('over'), title: 'Over',
    });
    expect(error?.message ?? '')
      .toContain(`at most ${limits.ballots_per_organization} ballots`);

    await organizer.from('organizations').delete().eq('id', org!.id);
  });

  test('the app schema itself stays off the API', async () => {
    const { error } = await voter.rpc('max_ballots_per_organization');
    expect(error).not.toBeNull();
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
