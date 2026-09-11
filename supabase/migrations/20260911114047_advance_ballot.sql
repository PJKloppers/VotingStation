-- ============================================================================
-- VotingStation :: the chair's one button
--
-- Running a meeting one question at a time is three actions that always happen
-- together: close what is open, open what is next, and close the ballot when
-- there is no next. Doing them as three clicks leaves gaps where two gates are
-- open at once, or none is; doing them here makes the step atomic.
--
-- Order is the ballot's own: sort_order, then prompt, across every question
-- type at once -- which is what ballot_questions is for.
-- ============================================================================

create or replace function public.advance_ballot(p_ballot uuid)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_open   record;
  v_next   record;
  v_had    boolean := false;
begin
  perform public.app_require_owner(p_ballot);

  select q.* into v_open
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled and q.gate_open
   order by q.sort_order, q.prompt
   limit 1;
  v_had := found;

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
    -- Nothing left to put to the room.
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
