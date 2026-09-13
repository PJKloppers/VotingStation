/**
 * Every call the client can make, in one place.
 *
 * The split matters: the voter functions are RPCs because a static page cannot
 * be trusted with a PIN, a gate or a selection rule, while the organizer's
 * configuration is ordinary table access that row level security already
 * guards. Nothing here decides anything -- it only asks.
 */
import { supabase, SUPABASE_URL } from './supabase';
import { fingerprint } from './fingerprint';
import type {
  Accepted, Ballot, BallotResults, HighestOutrightQuestion, HighestXQuestion,
  Organization, OrganizationImage, OrgPage, QuestionOption, QuestionType,
  Refused, TokenReport, VoterState, YesNoQuestion,
} from './types';

export class ApiError extends Error {}

/**
 * Every column of `ballots` except `vote_salt`, which no grant exposes -- it is
 * the anonymity guarantee, and a `select('*')` here would be refused outright.
 */
const BALLOT_COLUMNS =
  'id, org_id, slug, title, description, status, mode, opens_at, closes_at, ' +
  'allow_vote_change, require_all, require_all_pins, anonymous, show_results_after, results_public, ' +
  'intro_message, waiting_message, all_done_message, thank_you_message, ' +
  'closed_message, already_voted_message, lobby_refresh_seconds, expires_at';

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

/* -------------------------------------------------------------- the public */

export async function ballotResults(ballotId: string): Promise<BallotResults | Refused> {
  const { data, error } = await supabase.rpc('ballot_results', { p_ballot: ballotId });
  return unwrap(data, error);
}

/**
 * The ballot behind a pair of slugs.
 *
 * Through an RPC, not a join: organizations are owner-only, so a voter arriving
 * at /vote/demo-society/agm-2026 cannot look the organization up themselves.
 */
export async function resolveBallot(
  orgSlug: string, ballotSlug: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('resolve_ballot', {
    p_org: orgSlug, p_ballot: ballotSlug,
  });
  if (error) throw new ApiError(error.message);
  return data;
}

/**
 * One organization and what it has published, by slug.
 *
 * Through an RPC because organizations are owner-only: this is the only thing
 * that may read one by slug, and it answers with published ballots alone.
 */
export async function orgPage(orgSlug: string): Promise<OrgPage | null> {
  const { data, error } = await supabase.rpc('org_ballots', { p_org: orgSlug });
  if (error) throw new ApiError(error.message);
  return data;
}

/** The readable link for a ballot: `<org slug>/<ballot slug>`. */
export async function ballotSlugs(
  ballotId: string,
): Promise<{ org: string; ballot: string } | null> {
  const { data, error } = await supabase.rpc('ballot_slugs', { p_ballot: ballotId });
  if (error) throw new ApiError(error.message);
  return data;
}

export async function ballotById(id: string): Promise<Ballot | null> {
  const { data } = await supabase
    .from('ballots').select(BALLOT_COLUMNS).eq('id', id).maybeSingle();
  return data as Ballot | null;
}

/* ---------------------------------------------------------------- the mark
 * An organization's logo. The bucket is public to read -- a voter has to see it
 * without an account, and a signed URL per slip on a printed sheet cannot work
 * -- so the client only ever needs the path.
 */

export const LOGO_BUCKET = 'org-logos';

/** The public URL of a stored object. */
export function logoUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
}

/** Every mark this user owns, keyed by organization. One query for a dashboard. */
export async function myOrgLogos(): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('organization_images').select('org_id, path').eq('kind', 'logo');
  if (error) throw new ApiError(error.message);
  return Object.fromEntries((data ?? []).map((r) => [r.org_id, r.path]));
}

export async function orgLogo(orgId: string): Promise<OrganizationImage | null> {
  const { data } = await supabase
    .from('organization_images')
    .select('*').eq('org_id', orgId).eq('kind', 'logo').maybeSingle();
  return data;
}

/**
 * Replaces an organization's logo.
 *
 * The old object is removed after the new row is written, not before: a failed
 * upload should leave the organization with the mark it had.
 */
export async function uploadOrgLogo(orgId: string, file: File): Promise<OrganizationImage> {
  const ext = (file.name.split('.').pop() ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${orgId}/${crypto.randomUUID()}.${ext || 'png'}`;

  const { error: upErr } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(path, file, { contentType: file.type || 'image/png', upsert: false });
  if (upErr) throw new ApiError(upErr.message);

  const previous = await orgLogo(orgId);

  const { data, error } = await supabase
    .from('organization_images')
    .upsert({
      org_id: orgId, kind: 'logo', bucket: LOGO_BUCKET, path,
      content_type: file.type || 'image/png', bytes: file.size,
    }, { onConflict: 'org_id,kind' })
    .select().single();

  if (error) {
    // Do not leave an orphan in the bucket behind a failed write.
    await supabase.storage.from(LOGO_BUCKET).remove([path]);
    throw new ApiError(error.message);
  }

  if (previous && previous.path !== path) {
    await supabase.storage.from(LOGO_BUCKET).remove([previous.path]);
  }
  return data;
}

export async function removeOrgLogo(orgId: string): Promise<void> {
  const current = await orgLogo(orgId);
  if (!current) return;
  const { error } = await supabase
    .from('organization_images').delete().eq('org_id', orgId).eq('kind', 'logo');
  if (error) throw new ApiError(error.message);
  await supabase.storage.from(LOGO_BUCKET).remove([current.path]);
}

/** The mark on the organization behind a ballot, for a page with no session. */
export async function ballotLogoPath(ballotId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('ballot_logo', { p_ballot: ballotId });
  if (error) throw new ApiError(error.message);
  return data;
}

/* ----------------------------------------------------------- the organizer */

/** The two quotas the insert triggers enforce. */
export interface Limits {
  organizations_per_user: number;
  ballots_per_organization: number;
}

/**
 * How much the database will let this account hold, or null if it will not say.
 *
 * The numbers live in `app.max_organizations_per_user()` and
 * `app.max_ballots_per_organization()` -- the same two functions the quota
 * triggers read, so there is nothing to drift from. But `app` is deliberately
 * off the REST surface, so they reach a client only through a wrapper in
 * `public`; until `public.app_limits()` exists this comes back null and the
 * dashboard counts without a ceiling rather than printing a number nobody
 * checked against the database.
 */
export async function limits(): Promise<Limits | null> {
  const { data, error } = await supabase.rpc('app_limits');
  return error ? null : (data as Limits);
}

/**
 * The signed-in user's organizations.
 *
 * The owner filter is belt and braces: row level security already answers only
 * with their own, and there is a test on the policy itself rather than on this
 * query. But a page that lists "whatever the database hands back" is one
 * loosened policy away from listing somebody else's work, and that is exactly
 * how this leaked once.
 */
export async function myOrganizations(): Promise<Organization[]> {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return [];
  const { data, error } = await supabase
    .from('organizations').select('*').eq('owner_id', user.user.id).order('name');
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

/**
 * Deletes an organization, and with it everything that hangs off one.
 *
 * The database does the work: organizations cascades to ballots, a ballot to
 * its questions, PINs and votes, and organization_images to the row naming the
 * mark -- whose own trigger then removes the object from the bucket. So this
 * is one delete, not a walk down a tree the client would have to keep in step
 * with the schema.
 *
 * The mark's file is asked for through storage first, and only as a courtesy.
 * The trigger removes storage's record of it either way, which is what makes
 * it gone; going through the storage API as well is what lets the service
 * reclaim the bytes rather than leave them unreferenced. A failure here is not
 * worth stopping for -- there may be no mark, and the delete below is the part
 * that matters.
 */
export async function deleteOrganization(id: string): Promise<void> {
  try {
    const mark = await orgLogo(id);
    if (mark) await supabase.storage.from(LOGO_BUCKET).remove([mark.path]);
  } catch {
    // the trigger still takes the row; see above
  }

  const { error } = await supabase.from('organizations').delete().eq('id', id);
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

/** Pushes a ballot's expiry back out to the full retention window. */
export async function renewBallot(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('renew_ballot', { p_ballot: id });
  const answer = unwrap(data, error) as { ok: boolean; expires_at: string };
  return answer.expires_at;
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

export interface Advanced {
  ok: boolean;
  error?: string;
  action?: 'opened' | 'advanced' | 'finished';
  closed?: { id: string; prompt: string };
  opened?: { id: string; prompt: string };
}

/** Close what is open, open what is next, or close the ballot if there is none. */
export async function advanceBallot(ballotId: string): Promise<Advanced> {
  const { data, error } = await supabase.rpc('advance_ballot', { p_ballot: ballotId });
  return unwrap(data, error);
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
