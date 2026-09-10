-- ============================================================================
-- VotingStation :: move the RLS helpers off the REST surface
--
-- PostgREST exposes `public`. The three helpers the policies call need EXECUTE
-- for every role, which would also make them callable at /rest/v1/rpc. Moving
-- them into a schema PostgREST does not expose makes the boundary structural
-- rather than a matter of which grants happen to be in place.
--
-- Nothing about who can see what changes here -- only where the machinery
-- lives. What remains callable by anon is the voter surface and the public
-- tally, which is the point of the system.
-- ============================================================================

create schema if not exists app;
grant usage on schema app to anon, authenticated;

create or replace function app.owns_ballot(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.ballots b
      join public.organizations o on o.id = b.org_id
     where b.id = p_ballot and o.owner_id = auth.uid()
  );
$$;

create or replace function app.ballot_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b where b.id = p_ballot and b.status <> 'draft'
  ) or app.owns_ballot(p_ballot);
$$;

create or replace function app.votes_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b
     where b.id = p_ballot and b.status <> 'draft' and b.results_public
  ) or app.owns_ballot(p_ballot);
$$;

revoke all on function app.owns_ballot(uuid), app.ballot_readable(uuid), app.votes_readable(uuid)
  from public;
grant execute on function app.owns_ballot(uuid)     to anon, authenticated;
grant execute on function app.ballot_readable(uuid) to anon, authenticated;
grant execute on function app.votes_readable(uuid)  to anon, authenticated;

-- ---------------------------------------------------- repoint the policies

drop policy ballots_read_public     on public.ballots;
drop policy ballots_update_own      on public.ballots;
drop policy ballots_delete_own      on public.ballots;
drop policy ballot_tokens_owner_all on public.ballot_tokens;

create policy ballots_read_public on public.ballots
  for select using (status <> 'draft' or app.owns_ballot(id));
create policy ballots_update_own on public.ballots
  for update to authenticated
  using (app.owns_ballot(id))
  with check (exists (select 1 from public.organizations o
                       where o.id = org_id and o.owner_id = auth.uid()));
create policy ballots_delete_own on public.ballots
  for delete to authenticated using (app.owns_ballot(id));

create policy ballot_tokens_owner_all on public.ballot_tokens
  for all to authenticated
  using (app.owns_ballot(ballot_id))
  with check (app.owns_ballot(ballot_id));

do $$
declare t text;
begin
  foreach t in array array[
    'questions_yes_no', 'questions_highest_outright', 'questions_highest_x'
  ] loop
    execute format('drop policy %1$s_read on public.%1$I', t);
    execute format('drop policy %1$s_write on public.%1$I', t);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (app.ballot_readable(ballot_id))
    $f$, t);
    execute format($f$
      create policy %1$s_write on public.%1$I
        for all to authenticated
        using (app.owns_ballot(ballot_id))
        with check (app.owns_ballot(ballot_id))
    $f$, t);
  end loop;
end $$;

do $$
declare
  opt_tables text[] := array['options_highest_outright', 'options_highest_x'];
  q_tables   text[] := array['questions_highest_outright', 'questions_highest_x'];
  i int; o text; q text;
begin
  for i in 1 .. array_length(opt_tables, 1) loop
    o := opt_tables[i]; q := q_tables[i];
    execute format('drop policy %1$s_read on public.%1$I', o);
    execute format('drop policy %1$s_write on public.%1$I', o);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (exists (
          select 1 from public.%2$I q
           where q.id = question_id and app.ballot_readable(q.ballot_id)))
    $f$, o, q);
    execute format($f$
      create policy %1$s_write on public.%1$I
        for all to authenticated
        using (exists (select 1 from public.%2$I q
                        where q.id = question_id and app.owns_ballot(q.ballot_id)))
        with check (exists (select 1 from public.%2$I q
                        where q.id = question_id and app.owns_ballot(q.ballot_id)))
    $f$, o, q);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['votes_yes_no', 'votes_highest_outright', 'votes_highest_x'] loop
    execute format('drop policy %1$s_read on public.%1$I', t);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (app.votes_readable(ballot_id))
    $f$, t);
  end loop;
end $$;

-- ------------------------------------------------- repoint the two callers

create or replace function public.app_require_owner(p_ballot uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not app.owns_ballot(p_ballot) then
    raise exception 'Not your ballot.' using errcode = '42501';
  end if;
end $$;

create or replace function public.ballot_results(p_ballot uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  b public.ballots;
  v_questions jsonb;
  v_tokens record;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ballot not found.');
  end if;
  if not app.votes_readable(p_ballot) then
    return jsonb_build_object('ok', false, 'error', 'This ballot does not publish its results.');
  end if;

  select coalesce(jsonb_agg(
           public.question_results(p_ballot, q.question_type, q.id)
           order by q.sort_order, q.prompt), '[]'::jsonb)
    into v_questions
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled;

  select count(*)::int as issued,
         count(*) filter (where questions_voted > 0)::int as used
    into v_tokens
    from public.ballot_tokens where ballot_id = p_ballot;

  return jsonb_build_object(
    'ok', true,
    'updated', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ballot', jsonb_build_object(
      'id', b.id, 'title', b.title, 'description', b.description,
      'status', b.status, 'mode', b.mode),
    'turnout', jsonb_build_object('issued', v_tokens.issued, 'used', v_tokens.used),
    'questions', v_questions
  );
end $$;
revoke all on function public.ballot_results(uuid) from public;
grant execute on function public.ballot_results(uuid) to anon, authenticated;

drop function public.app_owns_ballot(uuid);
drop function public.app_ballot_readable(uuid);
drop function public.app_votes_readable(uuid);

-- ----------------------------------------------- pin down the search paths

alter function public.app_window_error(public.ballots) set search_path = public;
alter function public.app_normalise_pin(text)          set search_path = public;
alter function public.touch_updated_at()               set search_path = public;

comment on table public.pin_attempts is
  'Failed PIN attempts per browser fingerprint. RLS is on with no policy on purpose: no role holds a grant, so only the security definer functions reach it.';
