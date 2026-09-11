/**
 * Every call the client can make, in one place.
 *
 * The split matters: the voter functions are RPCs because a static page cannot
 * be trusted with a PIN, a gate or a selection rule, while the organizer's
 * configuration is ordinary table access that row level security already
 * guards. Nothing here decides anything -- it only asks.
 */
import { supabase } from './supabase';
import { fingerprint } from './fingerprint';
import type {
  Accepted, Ballot, BallotResults, HighestOutrightQuestion, HighestXQuestion,
  Organization, OrgListing, PinMatch, QuestionOption, QuestionType, Refused,
  TokenReport, VoterState, YesNoQuestion,
} from './types';

export class ApiError extends Error {}

/**
 * Every column of `ballots` except `vote_salt`, which no grant exposes -- it is
 * the anonymity guarantee, and a `select('*')` here would be refused outright.
 */
const BALLOT_COLUMNS =
  'id, org_id, slug, title, description, status, mode, opens_at, closes_at, ' +
  'allow_vote_change, require_all, anonymous, show_results_after, results_public, ' +
  'intro_message, waiting_message, all_done_message, thank_you_message, ' +
  'closed_message, already_voted_message, lobby_refresh_seconds';

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new ApiError(error.message);
  if (data === null) throw new ApiError('No data returned.');
  return data;
}

/* --------------------------------------------------------------- the voter */

export async function voterState(ballotId: string, pin: string): Promise<VoterState | Refused> {
  const { data, error } = await supabase.rpc('voter_state', {
    p_ballot: ballotId, p_pin: pin, p_fingerprint: fingerprint(),
  });
  return unwrap(data, error);
}

export async function castYesNo(
  ballotId: string, pin: string, questionId: string, choice: 'yes' | 'no' | 'abstain',
): Promise<Accepted | Refused> {
  const { data, error } = await supabase.rpc('cast_yes_no', {
    p_ballot: ballotId, p_pin: pin, p_question: questionId,
    p_choice: choice, p_fingerprint: fingerprint(),
  });
  return unwrap(data, error);
}

export async function castHighestOutright(
  ballotId: string, pin: string, questionId: string,
  optionId: string | null, abstain: boolean,
): Promise<Accepted | Refused> {
  const { data, error } = await supabase.rpc('cast_highest_outright', {
    p_ballot: ballotId, p_pin: pin, p_question: questionId,
    p_option: optionId, p_abstain: abstain, p_fingerprint: fingerprint(),
  });
  return unwrap(data, error);
}

export async function castHighestX(
  ballotId: string, pin: string, questionId: string, optionIds: string[],
): Promise<Accepted | Refused> {
  const { data, error } = await supabase.rpc('cast_highest_x', {
    p_ballot: ballotId, p_pin: pin, p_question: questionId,
    p_options: optionIds, p_fingerprint: fingerprint(),
  });
  return unwrap(data, error);
}

/**
 * Which published ballots a PIN opens.
 *
 * A PIN is unique per ballot, not globally, so this can legitimately come back
 * with more than one and the caller has to ask which. Rate limited in the
 * database on the same terms as a PIN attempt.
 */
export async function findBallotsForPin(pin: string): Promise<{ ok: true; ballots: PinMatch[] } | Refused> {
  const { data, error } = await supabase.rpc('find_ballots_for_pin', {
    p_pin: pin, p_fingerprint: fingerprint(),
  });
  return unwrap(data, error);
}

/* -------------------------------------------------------------- the public */

export async function ballotResults(ballotId: string): Promise<BallotResults | Refused> {
  const { data, error } = await supabase.rpc('ballot_results', { p_ballot: ballotId });
  return unwrap(data, error);
}

export async function publicBallot(orgSlug: string, ballotSlug: string): Promise<Ballot | null> {
  const { data: org } = await supabase
    .from('organizations').select('id').eq('slug', orgSlug).maybeSingle();
  if (!org) return null;
  const { data } = await supabase
    .from('ballots').select(BALLOT_COLUMNS)
    .eq('org_id', org.id).eq('slug', ballotSlug).maybeSingle();
  return data as Ballot | null;
}

export async function ballotById(id: string): Promise<Ballot | null> {
  const { data } = await supabase
    .from('ballots').select(BALLOT_COLUMNS).eq('id', id).maybeSingle();
  return data as Ballot | null;
}

/**
 * The public directory: every organization with at least one published ballot,
 * and how many it has.
 *
 * `ballots!inner` makes the join decide which organizations appear, so one that
 * has only drafts is not listed at all. Only the ballot ids come back -- a
 * landing page should not pull every ballot of every organization to render a
 * list of names.
 */
export async function publicOrganizations(): Promise<OrgListing[]> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, slug, name, description, contact, ballots!inner(id)')
    .neq('ballots.status', 'draft')
    .order('name');
  if (error) throw new ApiError(error.message);
  return (data ?? []).map((row) => {
    const { ballots, ...org } = row as typeof row & { ballots: unknown[] };
    return { ...org, ballot_count: ballots.length } as OrgListing;
  });
}

/**
 * One organization's published ballots. Drafts are excluded explicitly rather
 * than left to row level security, so the public view stays the public view
 * even when the organization's own owner is the one reading it.
 */
export async function publicBallotsForOrg(orgId: string): Promise<Ballot[]> {
  const { data, error } = await supabase
    .from('ballots').select(BALLOT_COLUMNS)
    .eq('org_id', orgId)
    .neq('status', 'draft')
    .order('created_at', { ascending: false });
  return unwrap(data, error) as unknown as Ballot[];
}

/* ----------------------------------------------------------- the organizer */

export async function myOrganizations(): Promise<Organization[]> {
  const { data, error } = await supabase
    .from('organizations').select('*').order('name');
  return unwrap(data, error);
}

export async function createOrganization(
  input: { slug: string; name: string; description: string; contact: string },
): Promise<Organization> {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) throw new ApiError('Sign in first.');
  const { data, error } = await supabase
    .from('organizations')
    .insert({ ...input, owner_id: user.user.id })
    .select().single();
  return unwrap(data, error);
}

export async function updateOrganization(id: string, patch: Partial<Organization>): Promise<void> {
  const { error } = await supabase.from('organizations').update(patch).eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function ballotsForOrg(orgId: string): Promise<Ballot[]> {
  const { data, error } = await supabase
    .from('ballots').select(BALLOT_COLUMNS)
    .eq('org_id', orgId).order('created_at', { ascending: false });
  return unwrap(data, error) as unknown as Ballot[];
}

export async function createBallot(
  input: { org_id: string; slug: string; title: string; description: string },
): Promise<Ballot> {
  const { data, error } = await supabase
    .from('ballots').insert(input).select(BALLOT_COLUMNS).single();
  return unwrap(data, error) as unknown as Ballot;
}

export async function updateBallot(id: string, patch: Partial<Ballot>): Promise<void> {
  const { error } = await supabase.from('ballots').update(patch).eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function deleteBallot(id: string): Promise<void> {
  const { error } = await supabase.from('ballots').delete().eq('id', id);
  if (error) throw new ApiError(error.message);
}

/* ------------------------------------------------------------- questions
 * One table per type, so one accessor per type. The switch is the only place
 * that has to learn a new type's name.
 */

const QUESTION_TABLE: Record<QuestionType, string> = {
  yes_no: 'questions_yes_no',
  highest_outright: 'questions_highest_outright',
  highest_x: 'questions_highest_x',
};

const OPTION_TABLE: Partial<Record<QuestionType, string>> = {
  highest_outright: 'options_highest_outright',
  highest_x: 'options_highest_x',
};

export type AnyQuestion =
  | ({ type: 'yes_no' } & YesNoQuestion)
  | ({ type: 'highest_outright' } & HighestOutrightQuestion)
  | ({ type: 'highest_x' } & HighestXQuestion);

/** Every question on a ballot, of every type, in ballot order. */
export async function questionsForBallot(ballotId: string): Promise<AnyQuestion[]> {
  const loaded = await Promise.all(
    (Object.keys(QUESTION_TABLE) as QuestionType[]).map(async (type) => {
      const { data, error } = await supabase
        .from(QUESTION_TABLE[type]).select('*').eq('ballot_id', ballotId);
      if (error) throw new ApiError(error.message);
      return (data ?? []).map((row) => ({ ...row, type }) as AnyQuestion);
    }),
  );
  return loaded.flat().sort(
    (a, b) => a.sort_order - b.sort_order || a.prompt.localeCompare(b.prompt),
  );
}

export async function createQuestion(
  type: QuestionType, ballotId: string, prompt: string, sortOrder: number,
): Promise<AnyQuestion> {
  const { data, error } = await supabase
    .from(QUESTION_TABLE[type])
    .insert({ ballot_id: ballotId, prompt, sort_order: sortOrder })
    .select().single();
  return { ...unwrap(data, error), type } as AnyQuestion;
}

export async function updateQuestion(
  type: QuestionType, id: string, patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from(QUESTION_TABLE[type]).update(patch).eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function deleteQuestion(type: QuestionType, id: string): Promise<void> {
  const { error } = await supabase.from(QUESTION_TABLE[type]).delete().eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function optionsForQuestion(
  type: QuestionType, questionId: string,
): Promise<QuestionOption[]> {
  const table = OPTION_TABLE[type];
  if (!table) return [];
  const { data, error } = await supabase
    .from(table).select('*').eq('question_id', questionId)
    .order('sort_order').order('label');
  return unwrap(data, error);
}

export async function createOption(
  type: QuestionType, questionId: string, label: string, sortOrder: number,
): Promise<QuestionOption> {
  const table = OPTION_TABLE[type];
  if (!table) throw new ApiError('That question type has no options.');
  const { data, error } = await supabase
    .from(table).insert({ question_id: questionId, label, sort_order: sortOrder })
    .select().single();
  return unwrap(data, error);
}

/** Adds several options at once, keeping the order they were given in. */
export async function createOptions(
  type: QuestionType, questionId: string, labels: string[], startAt: number,
): Promise<QuestionOption[]> {
  const table = OPTION_TABLE[type];
  if (!table) throw new ApiError('That question type has no options.');
  if (labels.length === 0) return [];
  const { data, error } = await supabase
    .from(table)
    .insert(labels.map((label, i) => ({
      question_id: questionId, label, sort_order: startAt + i,
    })))
    .select();
  return unwrap(data, error);
}

export async function updateOption(
  type: QuestionType, id: string, patch: Partial<QuestionOption>,
): Promise<void> {
  const table = OPTION_TABLE[type];
  if (!table) return;
  const { error } = await supabase.from(table).update(patch).eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function deleteOption(type: QuestionType, id: string): Promise<void> {
  const table = OPTION_TABLE[type];
  if (!table) return;
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw new ApiError(error.message);
}

/* ------------------------------------------------------- the meeting floor */

export async function setGate(
  ballotId: string, type: QuestionType, questionId: string, open: boolean, only = false,
): Promise<void> {
  const { error } = await supabase.rpc('set_gate', {
    p_ballot: ballotId, p_type: type, p_question: questionId, p_open: open, p_only: only,
  });
  if (error) throw new ApiError(error.message);
}

export async function closeAllGates(ballotId: string): Promise<void> {
  const { error } = await supabase.rpc('close_all_gates', { p_ballot: ballotId });
  if (error) throw new ApiError(error.message);
}

/* ------------------------------------------------------------------ tokens */

export async function issueTokens(
  ballotId: string, count: number,
): Promise<Array<{ pin: string }>> {
  const { data, error } = await supabase.rpc('issue_tokens', {
    p_ballot: ballotId, p_count: count,
  });
  return unwrap(data, error);
}

export async function tokenReport(ballotId: string): Promise<TokenReport> {
  const { data, error } = await supabase.rpc('ballot_token_report', { p_ballot: ballotId });
  return unwrap(data, error);
}

export async function setTokenStatus(id: string, status: 'active' | 'disabled'): Promise<void> {
  const { error } = await supabase.from('ballot_tokens').update({ status }).eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function deleteToken(id: string): Promise<void> {
  const { error } = await supabase.from('ballot_tokens').delete().eq('id', id);
  if (error) throw new ApiError(error.message);
}

export async function resetToken(id: string, questionId?: string): Promise<void> {
  const { error } = await supabase.rpc('reset_token', {
    p_token: id, p_question: questionId ?? null,
  });
  if (error) throw new ApiError(error.message);
}

export async function clearBallotVotes(ballotId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_ballot_votes', { p_ballot: ballotId });
  if (error) throw new ApiError(error.message);
}
