-- ============================================================================
-- VotingStation :: the chair confirms the seats before round 1
--
-- The seat count is set when the question is added, but the chair only knows
-- the real number once nominations are in. Between settling nominations and
-- opening round 1, the chair confirms it (and may change it): 1 is a
-- chairperson, more a committee. Round 1 will not open, or settle, until they
-- have. After round 1 opens the number is fixed. See
-- docs/plan-recursion-confirm-seats.md.
--
-- Also fixes settle_round when fewer people are left than seats: they are all
-- elected and the vote ends with the rest of the seats empty, rather than
-- opening another round with nobody in it.
-- ============================================================================

alter table public.questions_recursion_filter
  add column seats_confirmed boolean not null default false;

-- Races already past nominations carry on as they are. (Before the guard
-- below knows the column, so this plain update is allowed.)
update public.questions_recursion_filter set seats_confirmed = true where phase <> 'nominating';

create or replace function app.rf_guard_question() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.rf_engine', true), '') = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    new.gate_open := false;  new.opened_at := null;  new.closed_at := null;
    new.current_round := 0;  new.phase := 'nominating';  new.winner_id := null;
    new.seats_confirmed := false;
    return new;
  end if;

  if (new.gate_open, new.opened_at, new.closed_at, new.current_round, new.phase, new.winner_id,
      new.seats_confirmed)
     is distinct from
     (old.gate_open, old.opened_at, old.closed_at, old.current_round, old.phase, old.winner_id,
      old.seats_confirmed)
  then
    raise exception 'A recursion filter is moved on with its round controls, not edited directly.'
      using errcode = '42501';
  end if;

  if new.seats is distinct from old.seats and app.rf_started(new.id) then
    raise exception 'The number of seats is fixed once the vote has started.'
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function app.rf_set_gate(p_question uuid, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  n int;
begin
  select * into q from public.questions_recursion_filter where id = p_question for update;
  if not found then return; end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;

  if p_open then
    if q.phase = 'decided' then
      raise exception '"%" is decided. There is no round left to open.', q.prompt;
    end if;
    select count(*) into n from app.rf_eligible(q.id, r.round_no);
    if r.kind = 'nomination' and n < 1 then
      raise exception 'There is nobody in the pool to nominate. Add people to "%" first.', q.prompt;
    end if;
    if r.kind = 'elimination' and r.round_no = 1 and not q.seats_confirmed then
      raise exception 'Confirm how many seats "%" fills before opening round 1.', q.prompt;
    end if;
    if r.kind = 'elimination' and n <= greatest(r.seats_open, 1) then
      if q.seats = 1 then
        raise exception 'Only % candidate(s) in round % of "%". End the vote with a winner, or add someone from the pool.',
          n, r.round_no, q.prompt;
      end if;
      raise exception 'Only % left for % seat(s) in "%". Settle the round to elect them all, or add someone from the pool.',
        n, r.seats_open, q.prompt;
    end if;
    update public.rounds_recursion_filter
       set gate_open = true, opened_at = now(), closed_at = null
     where id = r.id;
  else
    update public.rounds_recursion_filter
       set gate_open = false,
           closed_at = case when gate_open then now() else closed_at end
     where id = r.id;
  end if;

  perform app.rf_engine();
  update public.questions_recursion_filter q2
     set gate_open = r2.gate_open, opened_at = r2.opened_at, closed_at = r2.closed_at
    from public.rounds_recursion_filter r2
   where q2.id = q.id and r2.id = r.id;
end $$;

create or replace function public.tally_recursion_filter_race(p_question uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'phase', q.phase,
    'current_round', q.current_round,
    'stop_on_majority', q.stop_on_majority,
    'nominate_threshold', q.nominate_threshold,
    'seats', q.seats,
    'seats_confirmed', q.seats_confirmed,
    'winner', (select jsonb_build_object('id', o.id, 'label', o.label)
                 from public.options_recursion_filter o where o.id = q.winner_id),
    'elected', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label,
                                          'round', o.elected_round, 'seat', o.seat_no)
             order by o.seat_no, o.label)
        from public.options_recursion_filter o
       where o.question_id = q.id and o.status in ('elected', 'winner')), '[]'::jsonb),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'label', o.label, 'description', o.description,
               'status', o.status, 'joined_round', o.joined_round,
               'dropped_round', o.dropped_round, 'added_by_chair', o.added_by_chair,
               'elected_round', o.elected_round, 'seat_no', o.seat_no)
             order by o.sort_order, o.label)
        from public.options_recursion_filter o where o.question_id = q.id), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'round', r.round_no, 'kind', r.kind,
                 'settled', r.settled_at is not null,
                 'seats_open', case when r.kind = 'nomination' then q.seats else r.seats_open end,
                 'drop_count', r.drop_count,
                 'drop_rule', r.drop_rule,
                 'drop_votes', r.drop_votes,
                 'tally', public.tally_recursion_filter(q.id, r.round_no))
               || coalesce(r.outcome - 'tally', '{}'::jsonb)
             order by r.round_no)
        from public.rounds_recursion_filter r where r.question_id = q.id), '[]'::jsonb))
  from public.questions_recursion_filter q
  where q.id = p_question;
$$;

create or replace function public.settle_round(
  p_question uuid, p_tie_drop uuid[] default null, p_shortlist uuid[] default null,
  p_seat_tie uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  t jsonb;
  v_keep uuid[]; v_n int;
  v_elect uuid[]; v_seat_tied uuid[]; v_seat_k int; v_seat_choice uuid[];
  v_drop uuid[]; v_tied uuid[]; v_tie_k int; v_choice uuid[];
  v_seated int; v_seats_left int; v_left int; v_rest uuid[]; v_how text;
  v_elected jsonb; v_dropped jsonb; v_withdrawn jsonb; v_outcome jsonb;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round for update;
  if r.gate_open then
    return jsonb_build_object('ok', false, 'error', 'Close the round before settling it.');
  end if;

  t := public.tally_recursion_filter(q.id, r.round_no);

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label)), '[]'::jsonb)
    into v_withdrawn from public.options_recursion_filter
   where question_id = q.id and status = 'withdrawn' and dropped_round = r.round_no;

  -- ---------------------------------------------------------- nomination
  if r.kind = 'nomination' then
    if p_shortlist is not null then
      select coalesce(array_agg(o.id), '{}') into v_keep
        from public.options_recursion_filter o
       where o.question_id = q.id and o.id = any (p_shortlist) and o.status in ('pool', 'in');
    else
      select coalesce(array_agg((e ->> 'id')::uuid), '{}') into v_keep
        from jsonb_array_elements(t -> 'options') e
       where (e ->> 'qualifies')::boolean;
    end if;

    update public.options_recursion_filter
       set status = 'in', joined_round = 1, dropped_round = null
     where question_id = q.id and id = any (v_keep);

    select count(*) into v_n from public.options_recursion_filter
     where question_id = q.id and status = 'in';
    if v_n = 0 then
      return jsonb_build_object('ok', false, 'error',
        format('Nobody reached %s nomination(s). Lower the threshold, add people from the pool, or choose the shortlist yourself.',
               q.nominate_threshold),
        'needs', 'shortlist');
    end if;

    perform app.rf_open_next(q, r, jsonb_build_object(
      'tally', t || '{"settled": true}'::jsonb,
      'shortlist_by_chair', p_shortlist is not null,
      'shortlisted', (select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by sort_order, label)
                        from public.options_recursion_filter
                       where question_id = q.id and status = 'in'),
      'withdrawn', v_withdrawn), q.seats);

    return jsonb_build_object('ok', true, 'action', 'shortlisted', 'shortlisted', v_n,
      'message', case
        when v_n <= q.seats and q.seats > 1
          then format('Only %s on the shortlist for %s seats. Settle round 1 to elect them all, or add others from the pool first.', v_n, q.seats)
        when v_n = 1
          then 'Only one person is on the shortlist. End the vote with them as winner, or add others from the pool.'
        else format('%s people go through to round 1.', v_n) end);
  end if;

  -- --------------------------------------------------------- elimination
  if r.round_no = 1 and not q.seats_confirmed then
    return jsonb_build_object('ok', false, 'needs', 'seats',
      'error', 'Confirm how many seats are being filled before settling round 1.');
  end if;

  select coalesce(array_agg(x::uuid), '{}') into v_elect from jsonb_array_elements_text(t -> 'elect') x;
  select coalesce(array_agg(x::uuid), '{}') into v_seat_tied from jsonb_array_elements_text(t -> 'seat_tied') x;
  v_seat_k := coalesce((t ->> 'seat_tie_count')::int, 0);

  -- a tie on the last seat
  if v_seat_k > 0 then
    select coalesce(array_agg(distinct c), '{}') into v_seat_choice
      from unnest(coalesce(p_seat_tie, '{}'::uuid[])) c where c = any (v_seat_tied);
    if coalesce(array_length(v_seat_choice, 1), 0) <> v_seat_k then
      return jsonb_build_object('ok', false, 'needs', 'seat_tie',
        'error', format('More people have a majority than there are seats, and %s on a tie. Choose %s of them to elect.',
                        case when v_seat_k = 1 then 'the last seat falls' else 'the last ' || v_seat_k || ' seats fall' end, v_seat_k),
        'elect_from_tie', v_seat_k,
        'tied', (select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.label)
                   from public.options_recursion_filter o where o.id = any (v_seat_tied)));
    end if;
    v_elect := v_elect || v_seat_choice;
  end if;

  -- the drop rule, unless the seats are filled anyway
  v_drop := '{}';  v_tie_k := 0;
  if not (t ->> 'fills')::boolean then
    if t ->> 'drop_rule' is null then
      return jsonb_build_object('ok', false, 'needs', 'drop_rule',
        'error', 'Choose how people drop out of this round first.');
    end if;
    if t ->> 'drop_error' is not null then
      return jsonb_build_object('ok', false, 'needs', 'drop_rule', 'error', t ->> 'drop_error');
    end if;

    select coalesce(array_agg(x::uuid), '{}') into v_drop from jsonb_array_elements_text(t -> 'drop') x;
    select coalesce(array_agg(x::uuid), '{}') into v_tied from jsonb_array_elements_text(t -> 'tied') x;
    v_tie_k := coalesce((t ->> 'tie_drop_count')::int, 0);

    if v_tie_k > 0 then
      select coalesce(array_agg(distinct c), '{}') into v_choice
        from unnest(coalesce(p_tie_drop, '{}'::uuid[])) c where c = any (v_tied);
      if coalesce(array_length(v_choice, 1), 0) <> v_tie_k then
        return jsonb_build_object('ok', false, 'needs', 'tie_break',
          'error', format('The cut falls on a tie. Choose %s of the tied candidates to drop.', v_tie_k),
          'drop_from_tie', v_tie_k,
          'tied', (select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.label)
                     from public.options_recursion_filter o where o.id = any (v_tied)));
      end if;
      v_drop := v_drop || v_choice;
    end if;
  end if;

  -- ------------------------------------------------- nothing left to ask: apply it
  -- seats in order of this round's votes
  select coalesce(array_agg(x.id order by (e ->> 'votes')::int desc, e ->> 'label'), '{}')
    into v_elect
    from unnest(v_elect) as x(id)
    join jsonb_array_elements(t -> 'options') e on (e ->> 'id')::uuid = x.id;
  perform app.rf_seat(q.id, r.round_no, v_elect);

  update public.options_recursion_filter
     set status = 'dropped', dropped_round = r.round_no
   where question_id = q.id and id = any (v_drop);

  select count(*) into v_seated from public.options_recursion_filter
   where question_id = q.id and status in ('elected', 'winner');
  v_seats_left := greatest(q.seats - v_seated, 0);
  select count(*) into v_left from public.options_recursion_filter
   where question_id = q.id and status = 'in';

  v_how := 'majority';
  if v_seats_left > 0 and v_left <= v_seats_left then
    -- the people left are no more than the seats: all of them are in
    select coalesce(array_agg(o.id order by coalesce((e ->> 'votes')::int, -1) desc, o.label), '{}')
      into v_rest
      from public.options_recursion_filter o
      left join jsonb_array_elements(t -> 'options') e on (e ->> 'id')::uuid = o.id
     where o.question_id = q.id and o.status = 'in';
    perform app.rf_seat(q.id, r.round_no, v_rest);
    v_elect := v_elect || v_rest;
    v_how := 'last_left';
    v_seats_left := greatest(v_seats_left - coalesce(array_length(v_rest, 1), 0), 0);
    -- everyone left now holds a seat: nobody is left to vote on
    v_left := 0;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'seat', o.seat_no) order by o.seat_no), '[]'::jsonb)
    into v_elected from public.options_recursion_filter o where o.id = any (v_elect);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label) order by label), '[]'::jsonb)
    into v_dropped from public.options_recursion_filter where id = any (v_drop);

  v_outcome := jsonb_build_object(
    'tally', t || '{"settled": true}'::jsonb,
    'elected', v_elected,
    'dropped', v_dropped,
    'drop_rule', case when (t ->> 'fills')::boolean then null else t ->> 'drop_rule' end,
    'drop_n', case t ->> 'drop_rule' when 'count' then t -> 'drop_count'
                                       when 'votes' then t -> 'drop_votes' end,
    'tie_broken_by_chair', v_tie_k > 0, 'tie_choice', to_jsonb(v_choice),
    'seat_tie_broken_by_chair', v_seat_k > 0, 'seat_tie_choice', to_jsonb(v_seat_choice),
    'withdrawn', v_withdrawn,
    'seats_left', v_seats_left);

  if v_seats_left = 0 or v_left = 0 then
    perform app.rf_finish(q, r, v_outcome || jsonb_build_object('how', v_how));
    return jsonb_build_object('ok', true, 'action', 'decided', 'how', v_how,
      'elected', v_elected, 'seats_left', v_seats_left,
      'message', case
        when q.seats = 1 then format('%s wins%s.', v_elected -> 0 ->> 'label',
               case when v_how = 'majority' then ' with a majority' else ', the last one in' end)
        when v_seats_left > 0 then format('%s elected. Nobody is left for the last %s seat%s, so %s empty.',
               (select string_agg(e ->> 'label', ', ') from jsonb_array_elements(v_elected) e),
               v_seats_left, case when v_seats_left = 1 then '' else 's' end,
               case when v_seats_left = 1 then 'it stays' else 'they stay' end)
        else format('All %s seats are filled.', q.seats) end);
  end if;

  perform app.rf_open_next(q, r, v_outcome, v_seats_left);
  return jsonb_build_object('ok', true, 'action', 'next_round', 'round', r.round_no + 1,
    'elected', v_elected, 'dropped', v_dropped, 'seats_left', v_seats_left,
    'message', case
      when jsonb_array_length(v_elected) > 0
        then format('%s elected. Round %s: %s left for %s seat(s).',
               (select string_agg(e ->> 'label', ', ') from jsonb_array_elements(v_elected) e),
               r.round_no + 1, v_left, v_seats_left)
      else format('Round %s is ready with %s candidates.', r.round_no + 1, v_left) end);
end $$;

create or replace function public.clear_ballot_votes(p_ballot uuid)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare n int := 0; c int;
begin
  perform public.app_require_owner(p_ballot);
  update public.votes_yes_no set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_outright set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_x set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_recursion_filter set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;

  perform app.rf_engine();
  update public.questions_recursion_filter
     set winner_id = null, current_round = 0, phase = 'nominating',
         gate_open = false, opened_at = null, closed_at = null, seats_confirmed = false
   where ballot_id = p_ballot;
  delete from public.rounds_recursion_filter where ballot_id = p_ballot and round_no > 0;
  update public.rounds_recursion_filter
     set gate_open = false, opened_at = null, closed_at = null, settled_at = null,
         outcome = null, drop_count = null, drop_rule = null, drop_votes = null
   where ballot_id = p_ballot and round_no = 0;
  update public.options_recursion_filter o
     set status = 'pool', joined_round = null, dropped_round = null, added_by_chair = false,
         elected_round = null, seat_no = null
    from public.questions_recursion_filter q
   where q.id = o.question_id and q.ballot_id = p_ballot;

  update public.ballot_tokens set questions_voted = 0, last_vote_at = null
   where ballot_id = p_ballot;
  return jsonb_build_object('ok', true, 'voided', n);
end $function$;

-- The chair's answer to "how many seats are being filled?": after
-- nominations, before round 1 opens. Resets round 1 to match.
create function public.set_race_seats(p_question uuid, p_seats int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  n int; v_max int;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase <> 'eliminating' or q.current_round <> 1 then
    return jsonb_build_object('ok', false, 'error',
      'The seats are confirmed after nominations, before round 1 opens.');
  end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = 1 for update;
  if r.opened_at is not null or r.settled_at is not null
     or exists (select 1 from public.votes_recursion_filter v
                 where v.question_id = q.id and v.round_no = 1 and v.valid)
     or exists (select 1 from public.options_recursion_filter o
                 where o.question_id = q.id and o.status in ('elected', 'winner')) then
    return jsonb_build_object('ok', false, 'error', 'Round 1 has started: the number of seats is fixed.');
  end if;
  if p_seats is null or p_seats < 1 or p_seats > 500 then
    return jsonb_build_object('ok', false, 'error', 'Give a number of seats, 1 or more.');
  end if;

  perform app.rf_engine();
  update public.questions_recursion_filter
     set seats = p_seats, seats_confirmed = true
   where id = q.id;
  v_max := case when p_seats = 1 then q.pick_max else p_seats end;
  update public.rounds_recursion_filter
     set seats_open = p_seats, pick_max = v_max,
         pick_min = least(case when p_seats = 1 then q.pick_min else 1 end, v_max)
   where id = r.id;

  select count(*) into n from public.options_recursion_filter
   where question_id = q.id and status = 'in';
  return jsonb_build_object('ok', true, 'seats', p_seats, 'in_race', n,
    'message', case
      when n <= p_seats then format('%s on the shortlist for %s seat%s: there is nothing to vote on. Settle round 1 to elect them all, or add people from the pool.',
                                    n, p_seats, case when p_seats = 1 then '' else 's' end)
      when p_seats = 1 then format('One seat, %s people. Open round 1 when the room is ready.', n)
      else format('%s seats to fill from %s people. Open round 1 when the room is ready.', p_seats, n) end);
end $$;

revoke all on function public.set_race_seats(uuid, int) from public, anon;
grant execute on function public.set_race_seats(uuid, int) to authenticated;
