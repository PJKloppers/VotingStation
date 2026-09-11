-- ============================================================================
-- VotingStation :: waiting for the room
--
-- Some meetings cannot move on until everyone has answered -- a quorum rule, or
-- simply a chair who will not leave anyone behind. With this on, the step
-- button refuses to close a question while an active PIN has not voted on it,
-- and says how many are outstanding.
--
-- A disabled PIN is not waited for: it has been taken out of the room.
-- ============================================================================

alter table public.ballots
  add column require_all_pins boolean not null default false;

comment on column public.ballots.require_all_pins is
  'Gated mode: the chair cannot step past a question until every active PIN has voted on it.';

grant select (require_all_pins) on public.ballots to anon, authenticated;
grant insert (require_all_pins) on public.ballots to authenticated;
grant update (require_all_pins) on public.ballots to authenticated;

-- ------------------------------------------------------------- the counts

create or replace function app.eligible_pins(p_ballot uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.ballot_tokens
   where ballot_id = p_ballot and status = 'active';
$$;

/* How many distinct voters have a standing answer on one question. One branch
   per type, because one table per type is the whole design. */
create or replace function app.voted_on(p_type text, p_question uuid)
returns int language sql stable security definer set search_path = public as $$
  select (case p_type
    when 'yes_no' then
      (select count(distinct voter_key) from public.votes_yes_no
        where question_id = p_question and valid)
    when 'highest_outright' then
      (select count(distinct voter_key) from public.votes_highest_outright
        where question_id = p_question and valid)
    when 'highest_x' then
      (select count(distinct voter_key) from public.votes_highest_x
        where question_id = p_question and valid)
    else 0
  end)::int;
$$;

grant execute on function app.eligible_pins(uuid) to authenticated;
grant execute on function app.voted_on(text, uuid) to authenticated;

-- ------------------------------------------------- the step button waits

create or replace function public.advance_ballot(p_ballot uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  b        public.ballots;
  v_open   record;
  v_next   record;
  v_had    boolean := false;
  v_voted  int;
  v_due    int;
begin
  perform public.app_require_owner(p_ballot);
  select * into b from public.ballots where id = p_ballot;

  select q.* into v_open
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled and q.gate_open
   order by q.sort_order, q.prompt
   limit 1;
  v_had := found;

  -- Before anything closes: is the room finished with it?
  if v_had and b.require_all_pins then
    v_due   := app.eligible_pins(p_ballot);
    v_voted := app.voted_on(v_open.question_type, v_open.id);
    if v_due > 0 and v_voted < v_due then
      return jsonb_build_object(
        'ok', false,
        'error', format('%s of %s PINs have voted on "%s". This ballot waits for all of them.',
                        v_voted, v_due, v_open.prompt),
        'waiting', jsonb_build_object('voted', v_voted, 'eligible', v_due));
    end if;
  end if;

  -- Whatever the state was, at most one gate is open when this returns.
  perform public.close_all_gates(p_ballot);

  if not v_had then
    select q.* into v_next
      from public.ballot_questions q
     where q.ballot_id = p_ballot and q.enabled
     order by q.sort_order, q.prompt
     limit 1;

    if not found then
      return jsonb_build_object('ok', false, 'error', 'This ballot has no questions on it.');
    end if;

    perform public.set_gate(p_ballot, v_next.question_type, v_next.id, true, false);
    return jsonb_build_object(
      'ok', true, 'action', 'opened',
      'opened', jsonb_build_object('id', v_next.id, 'prompt', v_next.prompt));
  end if;

  select q.* into v_next
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled
     and (q.sort_order, q.prompt) > (v_open.sort_order, v_open.prompt)
   order by q.sort_order, q.prompt
   limit 1;

  if not found then
    update public.ballots set status = 'closed' where id = p_ballot;
    return jsonb_build_object(
      'ok', true, 'action', 'finished',
      'closed', jsonb_build_object('id', v_open.id, 'prompt', v_open.prompt));
  end if;

  perform public.set_gate(p_ballot, v_next.question_type, v_next.id, true, false);
  return jsonb_build_object(
    'ok', true, 'action', 'advanced',
    'closed', jsonb_build_object('id', v_open.id, 'prompt', v_open.prompt),
    'opened', jsonb_build_object('id', v_next.id, 'prompt', v_next.prompt));
end $$;

revoke all on function public.advance_ballot(uuid) from public;
grant execute on function public.advance_ballot(uuid) to authenticated;
