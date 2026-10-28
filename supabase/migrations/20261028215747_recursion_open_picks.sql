-- ============================================================================
-- VotingStation :: a race's picks may be left open
--
-- "Nominations per voter" and "Pick at most" can be left unset. Unset means
-- no limit beyond the list itself: a voter may nominate everyone in the pool,
-- or pick everyone in the round. A number still caps it. A committee's rounds
-- keep one vote per seat open, as before.
--
-- The seats are no longer asked for when the question is added (the chair
-- confirms them after nominations); the column keeps its default of 1.
-- ============================================================================

alter table public.questions_recursion_filter
  alter column nominate_max drop not null,
  alter column nominate_max set default null,
  alter column pick_max drop not null,
  alter column pick_max set default null;

alter table public.rounds_recursion_filter
  alter column pick_max drop not null,
  alter column pick_max set default null;

create or replace function public.cast_recursion_filter(
  p_ballot uuid, p_pin text, p_question uuid,
  p_options uuid[] default null, p_abstain boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.ballots;
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  a record;
  v_err text;
  v_sub uuid := gen_random_uuid();
  v_had boolean;
  v_chosen uuid[];
  v_count int; v_min int; v_max int; v_eligible int;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Ballot not found.'); end if;

  v_err := public.app_window_error(b);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'closed', true); end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then return jsonb_build_object('ok', false, 'error', a.error); end if;

  select * into q from public.questions_recursion_filter
   where id = p_question and ballot_id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Question not found on this ballot.'); end if;

  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;
  -- always gated, whatever the ballot's mode
  if not r.gate_open or r.settled_at is not null or q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error',
      format('Voting on "%s" is not open. Please wait for the chair.', q.prompt));
  end if;

  if coalesce(p_abstain, false) then
    if not q.allow_abstain then
      return jsonb_build_object('ok', false, 'error', 'This question does not allow abstentions.');
    end if;
    v_chosen := '{}';
  else
    select coalesce(array_agg(distinct e.id), '{}'::uuid[]) into v_chosen
      from app.rf_eligible(q.id, r.round_no) e
     where e.id = any (coalesce(p_options, '{}'::uuid[]));

    select count(*) into v_eligible from app.rf_eligible(q.id, r.round_no);
    if r.kind = 'nomination' then
      -- not set: everyone in the pool
      v_min := 1;  v_max := coalesce(q.nominate_max, v_eligible);
    else
      -- not set: everyone in the round
      v_min := least(r.pick_min, v_eligible);  v_max := coalesce(r.pick_max, v_eligible);
    end if;

    v_count := coalesce(array_length(v_chosen, 1), 0);
    if (select count(distinct x) from unnest(coalesce(p_options, '{}'::uuid[])) x) > v_count then
      return jsonb_build_object('ok', false, 'error',
        'Someone you chose is no longer in this round. Please choose again.');
    end if;
    if v_count < greatest(v_min, 1) then
      return jsonb_build_object('ok', false, 'error',
        format('Please choose at least %s.', greatest(v_min, 1)));
    end if;
    if v_count > v_max then
      return jsonb_build_object('ok', false, 'error', format('Please choose at most %s.', v_max));
    end if;
  end if;

  select exists (select 1 from public.votes_recursion_filter
                  where question_id = q.id and round_no = r.round_no
                    and voter_key = a.voter_key and valid)
    into v_had;

  if v_had and not b.allow_vote_change then
    return jsonb_build_object('ok', false, 'error', b.already_voted_message);
  end if;

  if v_had then
    update public.votes_recursion_filter set valid = false
     where question_id = q.id and round_no = r.round_no and voter_key = a.voter_key and valid;
  end if;

  if coalesce(p_abstain, false) then
    insert into public.votes_recursion_filter
      (question_id, ballot_id, voter_key, token_id, submission_id, weight, round_no, option_id, abstain)
    values (q.id, p_ballot, a.voter_key,
            case when b.anonymous then null else a.token_id end,
            v_sub, a.weight, r.round_no, null, true);
  else
    insert into public.votes_recursion_filter
      (question_id, ballot_id, voter_key, token_id, submission_id, weight, round_no, option_id)
    select q.id, p_ballot, a.voter_key,
           case when b.anonymous then null else a.token_id end,
           v_sub, a.weight, r.round_no, oid
      from unnest(v_chosen) as oid;
  end if;

  perform public.app_after_vote(p_ballot, a.token_id, a.voter_key);

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub,
    'question_id', q.id,
    'round', r.round_no,
    'message', b.thank_you_message,
    'results', case when b.show_results_after and public.app_question_settled(b, q.gate_open)
                    then public.question_results(p_ballot, 'recursion_filter', q.id) else null end,
    'state', public.voter_state(p_ballot, p_pin, p_fingerprint)
  );
end $$;

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
             -- not set: everyone who can be chosen this round
             'pick_max', coalesce(case when r.kind = 'nomination' then q.nominate_max else r.pick_max end,
                                  (select count(*) from app.rf_eligible(q.id, r.round_no))),
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
