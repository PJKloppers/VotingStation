-- ============================================================================
-- VotingStation :: row level security and grants
--
--   * Anyone may read organizations, live ballots, their questions and options.
--   * Anyone may read the votes of a ballot that publishes its results --
--     they are pseudonymous, and the point of the system is a public tally.
--   * Only the owning user may write a ballot's configuration.
--   * NOBODY reads ballot_tokens, pin_attempts or ballots.vote_salt over the
--     API. PIN handling happens only inside security-definer functions.
--   * NOBODY writes a vote table directly. Votes arrive only through the
--     cast_* functions, which enforce the gate, the PIN and the question rules.
-- ============================================================================

-- ------------------------------------------------------------ RLS helpers

create or replace function public.app_owns_ballot(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.ballots b
      join public.organizations o on o.id = b.org_id
     where b.id = p_ballot and o.owner_id = auth.uid()
  );
$$;

create or replace function public.app_ballot_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b where b.id = p_ballot and b.status <> 'draft'
  ) or public.app_owns_ballot(p_ballot);
$$;

create or replace function public.app_votes_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b
     where b.id = p_ballot and b.status <> 'draft' and b.results_public
  ) or public.app_owns_ballot(p_ballot);
$$;

-- ---------------------------------------------------------- organizations

alter table public.organizations enable row level security;

create policy organizations_read_all on public.organizations
  for select using (true);

create policy organizations_insert_own on public.organizations
  for insert to authenticated with check (owner_id = auth.uid());

create policy organizations_update_own on public.organizations
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy organizations_delete_own on public.organizations
  for delete to authenticated using (owner_id = auth.uid());

-- ----------------------------------------------------------------- ballots
-- vote_salt is excluded from every grant, so it is invisible over the API.

alter table public.ballots enable row level security;

revoke all on public.ballots from anon, authenticated;

grant select (
  id, org_id, slug, title, description, status, mode, opens_at, closes_at,
  allow_vote_change, require_all, anonymous, show_results_after, results_public,
  intro_message, waiting_message, all_done_message, thank_you_message,
  closed_message, already_voted_message, lobby_refresh_seconds,
  created_at, updated_at
) on public.ballots to anon, authenticated;

grant insert (
  org_id, slug, title, description, status, mode, opens_at, closes_at,
  allow_vote_change, require_all, anonymous, show_results_after, results_public,
  intro_message, waiting_message, all_done_message, thank_you_message,
  closed_message, already_voted_message, lobby_refresh_seconds
) on public.ballots to authenticated;

grant update (
  slug, title, description, status, mode, opens_at, closes_at,
  allow_vote_change, require_all, anonymous, show_results_after, results_public,
  intro_message, waiting_message, all_done_message, thank_you_message,
  closed_message, already_voted_message, lobby_refresh_seconds
) on public.ballots to authenticated;

grant delete on public.ballots to authenticated;

create policy ballots_read_public on public.ballots
  for select using (status <> 'draft' or public.app_owns_ballot(id));

create policy ballots_insert_own on public.ballots
  for insert to authenticated
  with check (exists (select 1 from public.organizations o
                       where o.id = org_id and o.owner_id = auth.uid()));

create policy ballots_update_own on public.ballots
  for update to authenticated
  using (public.app_owns_ballot(id))
  with check (exists (select 1 from public.organizations o
                       where o.id = org_id and o.owner_id = auth.uid()));

create policy ballots_delete_own on public.ballots
  for delete to authenticated using (public.app_owns_ballot(id));

-- ------------------------------------------------------------------ tokens
-- Owner only. Anon never touches this table; the cast_* functions do.

alter table public.ballot_tokens enable row level security;
revoke all on public.ballot_tokens from anon;
grant select, insert, update, delete on public.ballot_tokens to authenticated;

create policy ballot_tokens_owner_all on public.ballot_tokens
  for all to authenticated
  using (public.app_owns_ballot(ballot_id))
  with check (public.app_owns_ballot(ballot_id));

-- ------------------------------------------------------------ pin_attempts

alter table public.pin_attempts enable row level security;
revoke all on public.pin_attempts from anon, authenticated;

-- ---------------------------------------------------------- question_types

alter table public.question_types enable row level security;
create policy question_types_read_all on public.question_types for select using (true);

-- ------------------------------------------------ questions and options
-- Same shape for every type: readable with the ballot, writable by the owner.

do $$
declare t text;
begin
  foreach t in array array[
    'questions_yes_no', 'questions_highest_outright', 'questions_highest_x'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (public.app_ballot_readable(ballot_id))
    $f$, t);
    execute format($f$
      create policy %1$s_write on public.%1$I
        for all to authenticated
        using (public.app_owns_ballot(ballot_id))
        with check (public.app_owns_ballot(ballot_id))
    $f$, t);
  end loop;
end $$;

do $$
declare
  opt_tables text[] := array['options_highest_outright', 'options_highest_x'];
  q_tables   text[] := array['questions_highest_outright', 'questions_highest_x'];
  i int;
  o text;
  q text;
begin
  for i in 1 .. array_length(opt_tables, 1) loop
    o := opt_tables[i];
    q := q_tables[i];
    execute format('alter table public.%I enable row level security', o);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (exists (
          select 1 from public.%2$I q
           where q.id = question_id and public.app_ballot_readable(q.ballot_id)))
    $f$, o, q);
    execute format($f$
      create policy %1$s_write on public.%1$I
        for all to authenticated
        using (exists (select 1 from public.%2$I q
                        where q.id = question_id and public.app_owns_ballot(q.ballot_id)))
        with check (exists (select 1 from public.%2$I q
                        where q.id = question_id and public.app_owns_ballot(q.ballot_id)))
    $f$, o, q);
  end loop;
end $$;

-- ------------------------------------------------------------------- votes
-- Readable when the ballot publishes results. Never writable over the API.

do $$
declare t text;
begin
  foreach t in array array[
    'votes_yes_no', 'votes_highest_outright', 'votes_highest_x'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (public.app_votes_readable(ballot_id))
    $f$, t);
  end loop;
end $$;
