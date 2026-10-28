-- ============================================================================
-- VotingStation :: seats, and the drop-off question
--
-- A recursion filter can fill more than one seat. Each round, everyone with a
-- majority (more than half of the round's voters, abstainers aside) is elected
-- on the spot, up to the seats still open; voters then get one vote per seat
-- left. It ends when the seats are filled, or when the people left are no
-- more than the seats left, who are then all elected. See
-- docs/plan-recursion-seats.md.
--
-- seats = 1 is the race as it was: a majority wins, or the last one in.
--
-- How people drop out is now a rule the chair sets each round:
--   count  the lowest N (a tie at the cut is the chair's to break)
--   votes  everyone on X votes or fewer (ties go together, never a tie-break)
--   none   nobody this round
-- A round that does not fill the seats will not settle without one, and no
-- rule may leave fewer people than seats left.
-- ============================================================================

-- --------------------------------------------------------------- columns

alter table public.questions_recursion_filter
  add column seats int not null default 1 check (seats >= 1);

alter table public.options_recursion_filter
  drop constraint options_recursion_filter_status_check,
  add constraint options_recursion_filter_status_check
    check (status in ('pool', 'in', 'dropped', 'withdrawn', 'winner', 'elected')),
  add column elected_round int,
  add column seat_no int;

alter table public.rounds_recursion_filter
  add column seats_open int not null default 1 check (seats_open >= 0),
  add column drop_rule text check (drop_rule in ('count', 'votes', 'none')),
  add column drop_votes int check (drop_votes >= 0);

-- Rounds already on record used a count.
update public.rounds_recursion_filter set drop_rule = 'count' where drop_count is not null;

-- A one-seat winner from before is an elected candidate in seat 1.
update public.options_recursion_filter o
   set elected_round = r.round_no, seat_no = 1
  from public.rounds_recursion_filter r
 where o.status = 'winner' and r.question_id = o.question_id
   and r.outcome ->> 'winner' = o.id::text;

-- ------------------------------------------------- the seats stay put once begun

create or replace function app.rf_guard_question() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.rf_engine', true), '') = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    new.gate_open := false;  new.opened_at := null;  new.closed_at := null;
    new.current_round := 0;  new.phase := 'nominating';  new.winner_id := null;
    return new;
  end if;

  if (new.gate_open, new.opened_at, new.closed_at, new.current_round, new.phase, new.winner_id)
     is distinct from
     (old.gate_open, old.opened_at, old.closed_at, old.current_round, old.phase, old.winner_id)
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

-- --------------------------------------------------------------- the count

-- One round's count, and what settling it would do now: who is elected, who
-- is tied at the seat line, and who the drop rule removes from the rest.
create or replace function public.tally_recursion_filter(p_question uuid, p_round int default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  v_options jsonb;
  v_voters int; v_ballots int; v_abstain int;
  v_pick_min int; v_pick_max int; v_eligible int;
  v_asc uuid[]; v_votes int[]; v_n int;
  v_seats int; v_rule text;
  v_maj uuid[] := '{}'; v_majv int[] := '{}'; v_m int;
  v_elect uuid[] := '{}'; v_seat_tied uuid[] := '{}'; v_seat_k int := 0; v_line int;
  v_rest uuid[] := '{}'; v_restv int[] := '{}'; v_rn int;
  v_cut int; v_below uuid[] := '{}'; v_equal uuid[] := '{}';
  v_drop uuid[] := '{}'; v_tied uuid[] := '{}'; v_tie_k int := 0;
  v_in int; v_seats_after int; v_in_after int; v_left int;
  v_fills boolean := false; v_drop_error text;
  i int;
begin
  select * into q from public.questions_recursion_filter where id = p_question;
  if not found then return null; end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = coalesce(p_round, q.current_round);
  if not found then return null; end if;

  if r.settled_at is not null and r.outcome ? 'tally' then
    return r.outcome -> 'tally';
  end if;

  -- voters in this round: each counts once, at their weight
  select count(*)::int,
         coalesce(sum(w) filter (where not ab), 0)::int,
         coalesce(sum(w) filter (where ab), 0)::int
    into v_voters, v_ballots, v_abstain
    from (select v.voter_key, max(v.weight) as w, bool_or(v.abstain) as ab
            from public.votes_recursion_filter v
           where v.question_id = q.id and v.round_no = r.round_no and v.valid
           group by v.voter_key) s;

  select count(*)::int into v_eligible from app.rf_eligible(q.id, r.round_no);
  v_seats := case when r.kind = 'nomination' then q.seats else r.seats_open end;
  v_rule := coalesce(r.drop_rule, case when r.drop_count is not null then 'count' end);

  if r.kind = 'nomination' then
    v_pick_min := 1;  v_pick_max := least(q.nominate_max, greatest(v_eligible, 1));
  else
    v_pick_min := least(r.pick_min, greatest(v_eligible, 1));
    v_pick_max := least(r.pick_max, greatest(v_eligible, 1));
  end if;

  -- every candidate in this round with their count, lowest first
  select coalesce(array_agg(c.id order by c.votes, c.label), '{}'),
         coalesce(array_agg(c.votes order by c.votes, c.label), '{}')
    into v_asc, v_votes
    from (select e.id, e.label,
                 coalesce((select sum(v.weight) from public.votes_recursion_filter v
                            where v.option_id = e.id and v.round_no = r.round_no and v.valid), 0)::int as votes
            from app.rf_eligible(q.id, r.round_no) e) c;
  v_n := coalesce(array_length(v_asc, 1), 0);

  if r.kind = 'elimination' then
    -- 1. the majority, most votes first
    if q.stop_on_majority and v_ballots > 0 then
      select coalesce(array_agg(x.id order by x.votes desc, o.label), '{}'),
             coalesce(array_agg(x.votes order by x.votes desc, o.label), '{}')
        into v_maj, v_majv
        from unnest(v_asc, v_votes) as x(id, votes)
        join public.options_recursion_filter o on o.id = x.id
       where x.votes > 0 and x.votes * 2 > v_ballots;
    end if;
    v_m := coalesce(array_length(v_maj, 1), 0);

    -- 2. elected, up to the seats open; a tie on the last seat is the chair's
    if v_m <= v_seats then
      v_elect := v_maj;
    else
      v_line := v_majv[v_seats];
      for i in 1 .. v_m loop
        if v_majv[i] > v_line then v_elect := v_elect || v_maj[i];
        elsif v_majv[i] = v_line then v_seat_tied := v_seat_tied || v_maj[i];
        end if;
      end loop;
      v_seat_k := v_seats - coalesce(array_length(v_elect, 1), 0);
      if v_seat_k = coalesce(array_length(v_seat_tied, 1), 0) then
        v_elect := v_elect || v_seat_tied;  v_seat_tied := '{}';  v_seat_k := 0;
      end if;
    end if;

    -- 3. what is left: the seats, and the people still in the race
    select count(*)::int into v_in from public.options_recursion_filter
     where question_id = q.id and status = 'in';
    v_seats_after := v_seats - coalesce(array_length(v_elect, 1), 0) - v_seat_k;
    v_in_after := v_in - coalesce(array_length(v_elect, 1), 0) - v_seat_k;
    v_fills := v_seats_after <= 0 or v_in_after <= v_seats_after;

    -- 4. the drop rule, over this round's candidates who were not elected
    for i in 1 .. v_n loop
      if not (v_asc[i] = any (v_elect) or v_asc[i] = any (v_seat_tied)) then
        v_rest := v_rest || v_asc[i];  v_restv := v_restv || v_votes[i];
      end if;
    end loop;
    v_rn := coalesce(array_length(v_rest, 1), 0);

    if not v_fills then
      if v_rule = 'count' and coalesce(r.drop_count, 0) > 0 then
        if r.drop_count > v_rn then
          v_drop_error := format('Only %s can drop from this round.', v_rn);
        else
          v_cut := v_restv[r.drop_count];
          for i in 1 .. v_rn loop
            if v_restv[i] < v_cut then v_below := v_below || v_rest[i];
            elsif v_restv[i] = v_cut then v_equal := v_equal || v_rest[i];
            end if;
          end loop;
          v_tie_k := r.drop_count - coalesce(array_length(v_below, 1), 0);
          if v_tie_k = coalesce(array_length(v_equal, 1), 0) then
            v_drop := v_below || v_equal;  v_tie_k := 0;
          else
            v_drop := v_below;  v_tied := v_equal;
          end if;
        end if;
      elsif v_rule = 'votes' then
        for i in 1 .. v_rn loop
          if v_restv[i] <= r.drop_votes then v_drop := v_drop || v_rest[i]; end if;
        end loop;
      end if;

      v_left := v_in_after - coalesce(array_length(v_drop, 1), 0) - v_tie_k;
      if v_drop_error is null and v_left < v_seats_after then
        v_drop_error := format('This drops %s and leaves %s for %s seat%s. Lower the number.',
          coalesce(array_length(v_drop, 1), 0) + v_tie_k, v_left, v_seats_after,
          case when v_seats_after = 1 then '' else 's' end);
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'label', e.label, 'description', e.description,
           'votes', x.votes,
           'share', case when v_ballots > 0 then round(x.votes::numeric / v_ballots, 4) else 0 end,
           'qualifies', r.kind = 'nomination' and x.votes >= q.nominate_threshold,
           'majority', e.id = any (v_maj),
           'elected', e.id = any (v_elect),
           'seat_tied', e.id = any (v_seat_tied),
           'drops', e.id = any (v_drop),
           'tied', e.id = any (v_tied))
         order by x.votes desc, e.label), '[]'::jsonb)
    into v_options
    from app.rf_eligible(q.id, r.round_no) e
    join unnest(v_asc, v_votes) as x(id, votes) on x.id = e.id;

  return jsonb_build_object(
    'round', r.round_no,
    'kind', r.kind,
    'gate_open', r.gate_open,
    'opened', r.opened_at is not null,
    'settled', false,
    'voters', v_voters,
    'ballots', v_ballots,
    'abstain', v_abstain,
    'pick_min', v_pick_min,
    'pick_max', v_pick_max,
    'threshold', case when r.kind = 'nomination' then q.nominate_threshold end,
    'seats', q.seats,
    'seats_open', v_seats,
    'drop_rule', v_rule,
    'drop_count', r.drop_count,
    'drop_votes', r.drop_votes,
    'stop_on_majority', q.stop_on_majority,
    'majority', case when q.seats = 1 and coalesce(array_length(v_elect, 1), 0) = 1
                     then to_jsonb(v_elect[1]) end,
    'elect', to_jsonb(v_elect),
    'seat_tied', to_jsonb(v_seat_tied),
    'seat_tie_count', v_seat_k,
    'fills', v_fills,
    'seats_after', greatest(coalesce(v_seats_after, v_seats), 0),
    'left_after', v_left,
    'drop_error', v_drop_error,
    'drop', to_jsonb(v_drop),
    'tied', to_jsonb(v_tied),
    'tie_drop_count', v_tie_k,
    'options', v_options);
end $$;

-- The whole race, now with the seats and who holds them.
create or replace function public.tally_recursion_filter_race(p_question uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'phase', q.phase,
    'current_round', q.current_round,
    'stop_on_majority', q.stop_on_majority,
    'nominate_threshold', q.nominate_threshold,
    'seats', q.seats,
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

-- ------------------------------------------------------------ the gate

-- An elimination round needs more people than seats: otherwise there is
-- nothing to vote on, and settling it elects them all.
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

-- ---------------------------------------------------- the drop-off question

-- How people drop out of the round under way: the lowest N, everyone on X
-- votes or fewer, or nobody. Refused if it would leave fewer than the seats.
create function public.set_round_drop(p_question uuid, p_rule text, p_n int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  t jsonb;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round for update;
  if r.kind <> 'elimination' then
    return jsonb_build_object('ok', false, 'error',
      'The nomination round drops nobody: it keeps everyone who reaches the threshold.');
  end if;
  if p_rule is null or p_rule not in ('count', 'votes', 'none') then
    return jsonb_build_object('ok', false, 'error', 'Choose how people drop out: the lowest N, X votes or fewer, or nobody.');
  end if;
  if p_rule <> 'none' and (p_n is null or p_n < 0) then
    return jsonb_build_object('ok', false, 'error', 'Give a number, 0 or more.');
  end if;

  update public.rounds_recursion_filter
     set drop_rule = p_rule,
         drop_count = case when p_rule = 'count' then p_n end,
         drop_votes = case when p_rule = 'votes' then p_n end
   where id = r.id;

  t := public.tally_recursion_filter(q.id);
  if t ->> 'drop_error' is not null then
    update public.rounds_recursion_filter
       set drop_rule = r.drop_rule, drop_count = r.drop_count, drop_votes = r.drop_votes
     where id = r.id;
    return jsonb_build_object('ok', false, 'error', t ->> 'drop_error', 'needs', 'drop_rule');
  end if;
  return jsonb_build_object('ok', true, 'tally', t);
end $$;

-- The old call, kept: a count.
create or replace function public.set_round_drop_count(p_question uuid, p_drop int)
returns jsonb
language sql security definer set search_path = public as $$
  select public.set_round_drop(p_question, 'count', p_drop);
$$;

-- Picks per voter: a committee round never offers more votes than seats open.
create or replace function public.set_round_picks(p_question uuid, p_min int, p_max int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
begin
  q := app.rf_question_for_chair(p_question);
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;
  if q.phase = 'decided' or r.kind <> 'elimination' then
    return jsonb_build_object('ok', false, 'error',
      'Picks per voter are set on elimination rounds. The nomination round uses the question''s nominations per voter.');
  end if;
  if r.gate_open or exists (select 1 from public.votes_recursion_filter v
                             where v.question_id = q.id and v.round_no = r.round_no and v.valid) then
    return jsonb_build_object('ok', false, 'error',
      'Picks per voter can only change before anyone has voted in this round.');
  end if;
  if p_min is null or p_max is null or p_min < 1 or p_max < p_min then
    return jsonb_build_object('ok', false, 'error', 'Picks must be at least 1, and the most no lower than the least.');
  end if;
  if q.seats > 1 and p_max > r.seats_open then
    return jsonb_build_object('ok', false, 'error',
      format('A voter has at most one vote per seat open: %s this round.', r.seats_open));
  end if;
  update public.rounds_recursion_filter set pick_min = p_min, pick_max = p_max where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------- moving the race on

-- The next round, with one vote per seat left (a one-seat race keeps the
-- question's own picks).
create function app.rf_open_next(
  q public.questions_recursion_filter, r public.rounds_recursion_filter,
  p_outcome jsonb, p_seats_left int
) returns void
language plpgsql security definer set search_path = public as $$
declare v_max int; v_min int;
begin
  v_max := case when q.seats = 1 then q.pick_max else p_seats_left end;
  v_min := least(case when q.seats = 1 then q.pick_min else 1 end, v_max);
  update public.rounds_recursion_filter
     set settled_at = now(), gate_open = false, outcome = p_outcome || '{"winner": null}'::jsonb
   where id = r.id;
  insert into public.rounds_recursion_filter
    (question_id, ballot_id, round_no, kind, pick_min, pick_max, seats_open)
  values (q.id, q.ballot_id, r.round_no + 1, 'elimination', v_min, v_max, p_seats_left);
  perform app.rf_engine();
  update public.questions_recursion_filter
     set current_round = r.round_no + 1, phase = 'eliminating'
   where id = q.id;
end $$;

-- Gives seats to people, in the order given, after those already seated.
create function app.rf_seat(p_question uuid, p_round int, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_base int;
begin
  select coalesce(max(seat_no), 0) into v_base from public.options_recursion_filter
   where question_id = p_question and status in ('elected', 'winner');
  update public.options_recursion_filter o
     set status = 'elected', elected_round = p_round, seat_no = v_base + x.k, dropped_round = null
    from unnest(p_ids) with ordinality as x(id, k)
   where o.id = x.id and o.question_id = p_question;
end $$;

-- Ends the race: the round is settled, the question decided. A one-seat race
-- names its winner.
create function app.rf_finish(
  q public.questions_recursion_filter, r public.rounds_recursion_filter, p_outcome jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare v_winner uuid;
begin
  if q.seats = 1 then
    select id into v_winner from public.options_recursion_filter
     where question_id = q.id and status in ('elected', 'winner') order by seat_no limit 1;
  end if;
  update public.rounds_recursion_filter
     set settled_at = now(), gate_open = false,
         outcome = p_outcome || jsonb_build_object('winner', to_jsonb(v_winner))
   where id = r.id;
  perform app.rf_engine();
  update public.questions_recursion_filter
     set phase = 'decided', winner_id = v_winner, gate_open = false
   where id = q.id;
end $$;

-- Settles the round. Nomination keeps whoever reached the threshold (or the
-- chair's shortlist). An elimination round elects the majority up to the
-- seats open, then applies the drop rule to the rest, then either fills the
-- seats or opens the next round. Each thing the chair still has to decide is
-- answered with { ok: false, needs } and nothing is changed.
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
        when v_seats_left > 0 then format('Nobody is left for the last %s seat(s). The vote ends with them empty.', v_seats_left)
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

-- The old three-argument call still resolves to the new one.
drop function if exists public.settle_round(uuid, uuid[], uuid[]);

-- The chair's stop: seats the people named (no more than the seats left), or
-- ends with the seats as they are.
create function public.end_recursion_seats(p_question uuid, p_elect uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  v_ids uuid[]; v_seated int; v_any boolean;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is already decided.');
  end if;
  if q.gate_open then
    return jsonb_build_object('ok', false, 'error', 'Close the round before ending the vote.');
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_elect, '{}'::uuid[])) x;
  if exists (select 1 from unnest(v_ids) x
              where not exists (select 1 from public.options_recursion_filter o
                                 where o.id = x and o.question_id = q.id and o.status = 'in')) then
    return jsonb_build_object('ok', false, 'error', 'Only people still in the race can be elected.');
  end if;
  select count(*) into v_seated from public.options_recursion_filter
   where question_id = q.id and status in ('elected', 'winner');
  if coalesce(array_length(v_ids, 1), 0) > q.seats - v_seated then
    return jsonb_build_object('ok', false, 'error',
      format('Only %s seat(s) are left.', q.seats - v_seated));
  end if;

  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round for update;
  select coalesce(array_agg(o.id order by o.label), '{}') into v_ids
    from public.options_recursion_filter o where o.id = any (v_ids);
  perform app.rf_seat(q.id, r.round_no, v_ids);
  v_any := v_seated + coalesce(array_length(v_ids, 1), 0) > 0;

  perform app.rf_finish(q, r, jsonb_build_object(
    'tally', public.tally_recursion_filter(q.id, r.round_no) || '{"settled": true}'::jsonb,
    'elected', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label, 'seat', seat_no) order by seat_no), '[]'::jsonb)
                  from public.options_recursion_filter where id = any (v_ids)),
    'ended_by_chair', true,
    'how', case when v_any then 'chair' else 'no_winner' end));
  return jsonb_build_object('ok', true, 'action', 'decided');
end $$;

create or replace function public.end_recursion(p_question uuid, p_winner uuid default null)
returns jsonb
language sql security definer set search_path = public as $$
  select public.end_recursion_seats(p_question,
    case when p_winner is null then null else array[p_winner] end);
$$;

-- ------------------------------------------------- shared functions, again

-- Clearing a ballot's votes resets the seats too.
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
         gate_open = false, opened_at = null, closed_at = null
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

-- The voter's screen says how many seats are open.
create or replace function public.voter_state(p_ballot uuid, p_pin text, p_fingerprint text default null)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  b public.ballots;
  a record;
  v_err text;
  v_questions jsonb;
  v_total int;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ballot not found.');
  end if;

  v_err := public.app_window_error(b);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err, 'closed', true);
  end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then
    return jsonb_build_object('ok', false, 'error', a.error);
  end if;

  with live as (
    select q.id, 'yes_no'::text as question_type, q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'yes_label', q.yes_label, 'no_label', q.no_label,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label,
             'pass_num', q.pass_num, 'pass_den', q.pass_den,
             'threshold_strict', q.threshold_strict
           ) as config,
           '[]'::jsonb as options,
           (select to_jsonb(v.choice) from public.votes_yes_no v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid
             limit 1) as previous
      from public.questions_yes_no q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    select q.id, 'highest_outright', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'require_majority', q.require_majority,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from public.options_highest_outright o
              where o.question_id = q.id and o.enabled), '[]'::jsonb),
           (select case when v.abstain then to_jsonb('abstain'::text) else to_jsonb(v.option_id) end
              from public.votes_highest_outright v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid
             limit 1)
      from public.questions_highest_outright q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    select q.id, 'highest_x', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'select_min', q.select_min, 'select_max', q.select_max,
             'winner_count', q.winner_count
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from public.options_highest_x o
              where o.question_id = q.id and o.enabled), '[]'::jsonb),
           (select jsonb_agg(v.option_id) from public.votes_highest_x v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid)
      from public.questions_highest_x q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    -- a recursion filter shows only while a round is open, whatever the mode
    select q.id, 'recursion_filter', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'round', r.round_no, 'kind', r.kind,
             'seats', q.seats,
             'seats_open', case when r.kind = 'nomination' then q.seats else r.seats_open end,
             'pick_min', case when r.kind = 'nomination' then 1
                              else least(r.pick_min, (select count(*) from app.rf_eligible(q.id, r.round_no))) end,
             'pick_max', case when r.kind = 'nomination' then q.nominate_max else r.pick_max end,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from app.rf_eligible(q.id, r.round_no) o), '[]'::jsonb),
           (select case when bool_or(v.abstain) then to_jsonb('abstain'::text)
                        else jsonb_agg(v.option_id) end
              from public.votes_recursion_filter v
             where v.question_id = q.id and v.round_no = r.round_no
               and v.voter_key = a.voter_key and v.valid
            having count(*) > 0)
      from public.questions_recursion_filter q
      join public.rounds_recursion_filter r
        on r.question_id = q.id and r.round_no = q.current_round
     where q.ballot_id = p_ballot and q.enabled and r.gate_open
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'type', question_type, 'prompt', prompt,
           'description', description, 'gate_open', gate_open,
           'config', config, 'options', options,
           'voted', previous is not null,
           'previous', coalesce(previous, 'null'::jsonb)
         ) order by sort_order, prompt), '[]'::jsonb)
    into v_questions
    from live;

  select count(*) into v_total from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled;

  return jsonb_build_object(
    'ok', true,
    'ballot', jsonb_build_object(
      'id', b.id, 'title', b.title, 'description', b.description,
      'mode', b.mode, 'allow_vote_change', b.allow_vote_change,
      'require_all', b.require_all, 'show_results_after', b.show_results_after,
      'waiting_message', b.waiting_message, 'all_done_message', b.all_done_message,
      'already_voted_message', b.already_voted_message,
      'lobby_refresh_seconds', b.lobby_refresh_seconds,
      'org_logo_path', app.ballot_logo_path(b.id)
    ),
    'voter', jsonb_build_object('weight', a.weight),
    'progress', jsonb_build_object(
      'voted', public.app_questions_voted(p_ballot, a.voter_key),
      'open_now', jsonb_array_length(v_questions),
      'total', v_total
    ),
    'questions', v_questions,
    -- what this voter has answered that is now finished, with its count
    'settled', public.app_settled_results(b, a.voter_key)
  );
end $function$;

-- ---------------------------------------------------------------- grants

revoke all on function public.set_round_drop(uuid, text, int) from public, anon;
grant execute on function public.set_round_drop(uuid, text, int) to authenticated;
revoke all on function public.end_recursion_seats(uuid, uuid[]) from public, anon;
grant execute on function public.end_recursion_seats(uuid, uuid[]) to authenticated;
revoke all on function public.settle_round(uuid, uuid[], uuid[], uuid[]) from public, anon;
grant execute on function public.settle_round(uuid, uuid[], uuid[], uuid[]) to authenticated;
revoke all on function app.rf_open_next(public.questions_recursion_filter, public.rounds_recursion_filter, jsonb, int) from public, anon, authenticated;
revoke all on function app.rf_seat(uuid, int, uuid[]) from public, anon, authenticated;
revoke all on function app.rf_finish(public.questions_recursion_filter, public.rounds_recursion_filter, jsonb) from public, anon, authenticated;
-- the replaced wrappers keep their grants (create or replace), but say so plainly
revoke all on function public.set_round_drop_count(uuid, int) from public, anon;
revoke all on function public.end_recursion(uuid, uuid) from public, anon;
