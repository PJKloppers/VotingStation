-- ============================================================================
-- VotingStation :: resetting a race
--
-- The chair can start a recursion filter again, in one of two ways:
--
--   rounds       Back to round 1, not yet opened. The nominations stand: the
--                shortlist they produced is in the race again, and everything
--                after them is undone (votes voided, rounds after 1 removed,
--                seats emptied, drops and withdrawals undone). Anyone the chair
--                added after nominations goes back to the pool.
--
--   nominations  Back to the very start: nominations not yet opened, everyone
--                in the pool, every vote in the race voided.
--
-- Votes are voided (valid = false), never deleted, as clear_ballot_votes does.
-- Any open gate on the race is closed. Only the ballot's owner may do it.
-- ============================================================================

create function public.reset_race(p_question uuid, p_scope text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r0 public.rounds_recursion_filter;
  v_short uuid[];
  v_max int;
  n int;
begin
  q := app.rf_question_for_chair(p_question);
  if p_scope is null or p_scope not in ('rounds', 'nominations') then
    return jsonb_build_object('ok', false, 'error', 'Reset the rounds, or the nominations too.');
  end if;

  select * into r0 from public.rounds_recursion_filter
   where question_id = q.id and round_no = 0 for update;

  if p_scope = 'rounds' then
    if r0.settled_at is null or q.current_round < 1 then
      return jsonb_build_object('ok', false, 'error',
        'There are no rounds to reset yet: nominations have not been settled.');
    end if;
    -- the shortlist the nominations produced
    select coalesce(array_agg((e ->> 'id')::uuid), '{}') into v_short
      from jsonb_array_elements(coalesce(r0.outcome -> 'shortlisted', '[]'::jsonb)) e;
  end if;

  perform app.rf_engine();

  -- every vote after nominations (or every vote) is voided
  update public.votes_recursion_filter set valid = false
   where question_id = q.id and valid
     and (p_scope = 'nominations' or round_no >= 1);
  get diagnostics n = row_count;

  if p_scope = 'rounds' then
    delete from public.rounds_recursion_filter where question_id = q.id and round_no >= 2;
    v_max := case when q.seats = 1 then q.pick_max else q.seats end;
    update public.rounds_recursion_filter
       set gate_open = false, opened_at = null, closed_at = null, settled_at = null,
           outcome = null, drop_count = null, drop_rule = null, drop_votes = null,
           seats_open = q.seats, pick_max = v_max,
           pick_min = least(case when q.seats = 1 then q.pick_min else 1 end, v_max)
     where question_id = q.id and round_no = 1;

    update public.options_recursion_filter
       set status = case when id = any (v_short) then 'in' else 'pool' end,
           joined_round = case when id = any (v_short) then 1 end,
           dropped_round = null, elected_round = null, seat_no = null,
           added_by_chair = false
     where question_id = q.id;

    update public.questions_recursion_filter
       set current_round = 1, phase = 'eliminating', winner_id = null,
           gate_open = false, opened_at = null, closed_at = null
     where id = q.id;
  else
    delete from public.rounds_recursion_filter where question_id = q.id and round_no >= 1;
    update public.rounds_recursion_filter
       set gate_open = false, opened_at = null, closed_at = null, settled_at = null,
           outcome = null, drop_count = null, drop_rule = null, drop_votes = null
     where question_id = q.id and round_no = 0;

    update public.options_recursion_filter
       set status = 'pool', joined_round = null, dropped_round = null,
           elected_round = null, seat_no = null, added_by_chair = false
     where question_id = q.id;

    update public.questions_recursion_filter
       set current_round = 0, phase = 'nominating', winner_id = null, seats_confirmed = false,
           gate_open = false, opened_at = null, closed_at = null
     where id = q.id;
  end if;

  -- each PIN's count of questions answered follows its votes
  update public.ballot_tokens t
     set questions_voted = public.app_questions_voted(t.ballot_id, public.app_voter_key(t.ballot_id, t.pin))
   where t.ballot_id = q.ballot_id;

  return jsonb_build_object('ok', true, 'voided', n,
    'message', case when p_scope = 'rounds'
      then format('"%s" is back at round 1, with the %s from nominations. Open round 1 when the room is ready.',
                  q.prompt, coalesce(array_length(v_short, 1), 0) || ' on the shortlist')
      else format('"%s" is back at the start: nominations are not yet open.', q.prompt) end);
end $$;

revoke all on function public.reset_race(uuid, text) from public, anon;
grant execute on function public.reset_race(uuid, text) to authenticated;
