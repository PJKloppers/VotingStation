/**
 * Removing and renaming a name on a race, against the real database.
 *
 * The editor's Remove went nowhere once nominations had opened: row security
 * hid the race's rows, so the delete touched nothing and said nothing. The
 * chair now removes and renames through remove_race_option and
 * rename_race_option. This checks what each does at each stage:
 *
 *   before the race      Remove deletes; the direct delete still works too
 *   nominations open     the direct delete changes nothing (the old bug);
 *                        Remove deletes a name nobody nominated, and
 *                        withdraws one somebody did -- their nominations stay
 *                        on record but leave the count, and nobody can
 *                        nominate them again
 *   after nominations    Remove withdraws, and refuses while a round is open
 *   always               only the ballot's owner; renames refuse blanks and
 *                        names already on the list
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, organizerClient, otherOrganizerClient, uniqueSlug } from '../helpers/env';

const NAMES = ['Anna Botha', 'Ben Cele', 'Cara Dlamini', 'Dan Els', 'Eve Fourie', 'Finn Gous'];

let organizer: SupabaseClient;
let stranger: SupabaseClient;
let ballotId = '';
let race = '';
let pins: string[] = [];
const id: Record<string, string> = {};

type Answer = { ok: boolean; error?: string; message?: string; removed?: 'deleted' | 'withdrawn' };

const rpc = async <T = Answer>(client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
};
const remove = (name: string, client = organizer) =>
  rpc(client, 'remove_race_option', { p_question: race, p_option: id[name] });
const gate = (open: boolean) => rpc(organizer, 'set_gate', {
  p_ballot: ballotId, p_type: 'recursion_filter', p_question: race, p_open: open,
});
const cast = (pin: string, names: string[]) => rpc(anonClient(), 'cast_recursion_filter', {
  p_ballot: ballotId, p_pin: pin, p_question: race, p_options: names.map((n) => id[n]),
});
async function row(name: string) {
  const { data } = await organizer.from('options_recursion_filter')
    .select('label, status').eq('id', id[name]!).maybeSingle();
  return data;
}

beforeAll(async () => {
  organizer = await organizerClient();
  stranger = await otherOrganizerClient();
  const { data: user } = await organizer.auth.getUser();
  const { data: org } = await organizer.from('organizations')
    .select('id').eq('owner_id', user.user!.id).limit(1).single();
  const { data: ballot } = await organizer.from('ballots').insert({
    org_id: org!.id, slug: uniqueSlug('it-remove'), title: 'Remove a name',
    status: 'live', mode: 'gated', allow_vote_change: true,
  }).select('id').single();
  ballotId = ballot!.id;
  const { data: q } = await organizer.from('questions_recursion_filter')
    .insert({ ballot_id: ballotId, prompt: 'Diakens', sort_order: 1 }).select('id').single();
  race = q!.id;
  const { data: opts } = await organizer.from('options_recursion_filter')
    .insert(NAMES.map((label, i) => ({ question_id: race, label, sort_order: i }))).select('id, label');
  for (const o of opts!) id[o.label] = o.id;
  const { data: issued } = await organizer.rpc('issue_tokens', { p_ballot: ballotId, p_count: 3 });
  pins = (issued as Array<{ pin: string }>).map((t) => t.pin);
});

afterAll(async () => {
  if (ballotId) await organizer.from('ballots').delete().eq('id', ballotId);
  await organizer.auth.signOut();
  await stranger.auth.signOut();
});

describe('removing a name from a race', () => {
  test('before the race begins, Remove deletes the name', async () => {
    const a = await remove('Finn Gous');
    expect(a).toMatchObject({ ok: true, removed: 'deleted' });
    expect(await row('Finn Gous')).toBeNull();
  });

  test('only the ballot\'s owner may remove or rename', async () => {
    const { error } = await stranger.rpc('remove_race_option', { p_question: race, p_option: id['Eve Fourie'] });
    expect(error?.message ?? '').toContain('Not your ballot');
    const { error: e2 } = await stranger.rpc('rename_race_option',
      { p_question: race, p_option: id['Eve Fourie'], p_label: 'X' });
    expect(e2?.message ?? '').toContain('Not your ballot');
    expect(await row('Eve Fourie')).toEqual({ label: 'Eve Fourie', status: 'pool' });
  });

  test('once nominations open, a direct delete changes nothing -- the bug behind the dead button', async () => {
    await gate(true);
    const { data, error } = await organizer.from('options_recursion_filter')
      .delete().eq('id', id['Eve Fourie']!).select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await row('Eve Fourie')).not.toBeNull();
  });

  test('with nominations open, a name nobody nominated is deleted', async () => {
    const a = await remove('Eve Fourie');
    expect(a).toEqual({ ok: true, removed: 'deleted', message: 'Eve Fourie is removed from the nominations.' });
    expect(await row('Eve Fourie')).toBeNull();
  });

  test('a name somebody nominated is withdrawn: on record, but out of the count', async () => {
    await cast(pins[0]!, ['Dan Els', 'Anna Botha']);
    await cast(pins[1]!, ['Dan Els']);
    const a = await remove('Dan Els');
    expect(a).toEqual({
      ok: true, removed: 'withdrawn',
      message: 'Dan Els is removed from the nominations. Their 2 nominations no longer count.',
    });
    expect(await row('Dan Els')).toEqual({ label: 'Dan Els', status: 'withdrawn' });
    const { count } = await organizer.from('votes_recursion_filter')
      .select('id', { count: 'exact', head: true }).eq('option_id', id['Dan Els']!).eq('valid', true);
    expect(count).toBe(2);

    // the count leaves them out; the voters stay counted
    type Round = { round: number; tally: { options: Array<{ label: string; votes: number }> } };
    const r = await rpc<{ questions: Array<{ id: string; tally: { rounds: Round[] } }> }>(
      organizer, 'ballot_results', { p_ballot: ballotId });
    const t = r.questions.find((q) => q.id === race)!.tally.rounds.find((x) => x.round === 0)!.tally;
    expect(t.options.map((o) => o.label).sort()).toEqual(['Anna Botha', 'Ben Cele', 'Cara Dlamini']);
    expect(t.options.find((o) => o.label === 'Anna Botha')?.votes).toBe(1);
  });

  test('nobody can nominate a removed name, and removing it again is refused', async () => {
    const refused = await cast(pins[2]!, ['Dan Els']);
    expect(refused.ok).toBe(false);
    expect(await cast(pins[2]!, ['Ben Cele'])).toMatchObject({ ok: true });
    expect(await remove('Dan Els')).toEqual({ ok: false, error: 'Dan Els is already out of the race.' });
  });

  test('a rename fixes a typo, and refuses a blank or a name already on the list', async () => {
    const ren = (name: string, label: string) =>
      rpc(organizer, 'rename_race_option', { p_question: race, p_option: id[name], p_label: label });
    expect(await ren('Cara Dlamini', '  ')).toEqual({ ok: false, error: 'A name cannot be blank.' });
    expect(await ren('Cara Dlamini', 'anna botha')).toEqual({ ok: false, error: 'anna botha is already on the list.' });
    expect(await ren('Cara Dlamini', 'Cara Dlamini-Smit')).toEqual({ ok: true, message: 'Renamed to Cara Dlamini-Smit.' });
    expect(await row('Cara Dlamini')).toEqual({ label: 'Cara Dlamini-Smit', status: 'pool' });
  });

  test('after nominations, Remove withdraws -- but not while a round is open', async () => {
    await gate(false);
    await rpc(organizer, 'settle_round', { p_question: race });
    await rpc(organizer, 'set_race_seats', { p_question: race, p_seats: 1 });
    await gate(true);
    expect(await remove('Ben Cele')).toEqual({ ok: false, error: 'Close the round before withdrawing anyone.' });
    expect((await row('Ben Cele'))!.status).toBe('in');
    await gate(false);
    expect(await remove('Ben Cele')).toMatchObject({
      ok: true, removed: 'withdrawn', message: 'Ben Cele is withdrawn from the race.',
    });
    expect((await row('Ben Cele'))!.status).toBe('withdrawn');
  });
});
