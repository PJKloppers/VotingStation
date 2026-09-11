-- ============================================================================
-- VotingStation :: a question publishes when its own gate closes
--
-- Publication used to be all-or-nothing on the ballot: nothing public until the
-- whole thing closed. That is wrong for a meeting, where the chair closes the
-- first motion and announces it long before the last one is put. The unit is
-- the question, not the ballot.
--
-- A question is public when the ballot publishes results at all AND that
-- question can no longer take a vote -- its gate is closed in gated mode, or
-- the whole ballot is closed. Open mode has no gates, so there it is still the
-- ballot closing that publishes, which is the only honest reading of "this
-- question is finished" when everything is open at once.
--
-- The organizer reads everything throughout; that is what the live monitor is.
-- ============================================================================

create or replace function app.question_public(p_ballot uuid, p_gate_open boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b
     where b.id = p_ballot
       and b.results_public
       and (b.status = 'closed' or (b.mode = 'gated' and not p_gate_open))
  );
$$;

grant execute on function app.question_public(uuid, boolean) to anon, authenticated;

/* Still used by ballot_results to decide whether to answer at all: a ballot
   that publishes nothing says so, rather than handing back an empty list. */
create or replace function app.votes_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b
     where b.id = p_ballot and b.status <> 'draft' and b.results_public
  ) or app.owns_ballot(p_ballot);
$$;

-- --------------------------------------------- the vote tables, per question

do $$
declare
  vote_tables text[] := array['votes_yes_no', 'votes_highest_outright', 'votes_highest_x'];
  q_tables    text[] := array['questions_yes_no', 'questions_highest_outright', 'questions_highest_x'];
  i int; v text; q text;
begin
  for i in 1 .. array_length(vote_tables, 1) loop
    v := vote_tables[i]; q := q_tables[i];
    execute format('drop policy %1$s_read on public.%1$I', v);
    execute format($f$
      create policy %1$s_read on public.%1$I
        for select using (
          app.owns_ballot(ballot_id)
          or exists (select 1 from public.%2$I q
                      where q.id = question_id
                        and app.question_public(ballot_id, q.gate_open))
        )
    $f$, v, q);
  end loop;
end $$;

-- ------------------------------------------------------------------ the tally

create or replace function public.ballot_results(p_ballot uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  b public.ballots;
  v_mine boolean;
  v_questions jsonb;
  v_withheld int;
  v_tokens record;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ballot not found.');
  end if;

  v_mine := app.owns_ballot(p_ballot);

  if not v_mine and not (b.status <> 'draft' and b.results_public) then
    return jsonb_build_object('ok', false, 'error', 'This ballot does not publish its results.');
  end if;

  -- The owner sees every question. Everyone else sees the finished ones, and is
  -- told plainly how many are being held back rather than shown a short list
  -- that looks like the whole ballot.
  select coalesce(jsonb_agg(
           public.question_results(p_ballot, q.question_type, q.id)
           order by q.sort_order, q.prompt), '[]'::jsonb)
    into v_questions
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled
     and (v_mine or app.question_public(p_ballot, q.gate_open));

  select count(*)::int into v_withheld
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled
     and not (v_mine or app.question_public(p_ballot, q.gate_open));

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
    'turnout', jsonb_build_object(
      'issued', v_tokens.issued, 'used', v_tokens.used,
      'eligible', app.eligible_pins(p_ballot)),
    'withheld', v_withheld,
    'questions', v_questions
  );
end $$;

revoke all on function public.ballot_results(uuid) from public;
grant execute on function public.ballot_results(uuid) to anon, authenticated;
