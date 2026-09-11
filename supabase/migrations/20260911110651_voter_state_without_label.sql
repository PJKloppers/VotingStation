-- ============================================================================
-- VotingStation :: voter_state without the token label
--
-- The lobby used to greet a voter by the label on their PIN. There is no label
-- any more, so the voter block is just their weight.
-- ============================================================================

create or replace function public.voter_state(
  p_ballot uuid, p_pin text, p_fingerprint text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
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
    -- yes / no
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
    -- highest outright
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
    -- highest X options
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
      'lobby_refresh_seconds', b.lobby_refresh_seconds
    ),
    'voter', jsonb_build_object('weight', a.weight),
    'progress', jsonb_build_object(
      'voted', public.app_questions_voted(p_ballot, a.voter_key),
      'open_now', jsonb_array_length(v_questions),
      'total', v_total
    ),
    'questions', v_questions
  );
end $$;

revoke all on function public.voter_state(uuid, text, text) from public;
grant execute on function public.voter_state(uuid, text, text) to anon, authenticated;
