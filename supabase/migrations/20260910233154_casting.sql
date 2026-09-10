-- ============================================================================
-- VotingStation :: casting a vote
--
-- One function per question type, because one function per type is what keeps
-- the arguments honest: a yes/no answer is an enum, an outright answer is one
-- option id, an X-of-N answer is an array of them.
--
-- Every one of them re-checks the gate at the moment of the click, not at the
-- moment the page was drawn, so a stale waiting screen cannot slip a vote
-- through a gate the chair has since closed.
--
-- Replacing a vote never deletes anything: the standing rows go valid = false
-- and the new ones are written beside them.
-- ============================================================================

create or replace function public.app_after_vote(
  p_ballot uuid, p_token uuid, p_voter_key text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ballot_tokens
     set questions_voted = public.app_questions_voted(p_ballot, p_voter_key),
         last_vote_at = now()
   where id = p_token;
end $$;

-- ------------------------------------------------------------- yes  /  no

create or replace function public.cast_yes_no(
  p_ballot uuid, p_pin text, p_question uuid, p_choice text,
  p_fingerprint text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  b public.ballots;
  q public.questions_yes_no;
  a record;
  v_err text;
  v_choice public.yes_no_choice;
  v_sub uuid := gen_random_uuid();
  v_had boolean;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Ballot not found.'); end if;

  v_err := public.app_window_error(b);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'closed', true); end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then return jsonb_build_object('ok', false, 'error', a.error); end if;

  select * into q from public.questions_yes_no
   where id = p_question and ballot_id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Question not found on this ballot.'); end if;
  if not q.enabled then return jsonb_build_object('ok', false, 'error', 'That question is not part of this ballot.'); end if;
  if b.mode = 'gated' and not q.gate_open then
    return jsonb_build_object('ok', false, 'error',
      format('Voting on "%s" is not open. Please wait for the chair.', q.prompt));
  end if;

  begin
    v_choice := lower(btrim(coalesce(p_choice, '')))::public.yes_no_choice;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'Please choose an answer.');
  end;

  if v_choice = 'abstain' and not q.allow_abstain then
    return jsonb_build_object('ok', false, 'error', 'This question does not allow abstentions.');
  end if;

  select exists (select 1 from public.votes_yes_no
                  where question_id = q.id and voter_key = a.voter_key and valid)
    into v_had;

  if v_had and not b.allow_vote_change then
    return jsonb_build_object('ok', false, 'error', b.already_voted_message);
  end if;

  if v_had then
    update public.votes_yes_no set valid = false
     where question_id = q.id and voter_key = a.voter_key and valid;
  end if;

  insert into public.votes_yes_no
    (question_id, ballot_id, voter_key, token_id, submission_id, weight, choice)
  values
    (q.id, p_ballot, a.voter_key,
     case when b.anonymous then null else a.token_id end,
     v_sub, a.weight, v_choice);

  perform public.app_after_vote(p_ballot, a.token_id, a.voter_key);

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub,
    'question_id', q.id,
    'message', b.thank_you_message,
    'results', case when b.show_results_after
                    then public.question_results(p_ballot, 'yes_no', q.id) else null end,
    'state', public.voter_state(p_ballot, p_pin, p_fingerprint)
  );
end $$;

-- ------------------------------------------------------- highest outright

create or replace function public.cast_highest_outright(
  p_ballot uuid, p_pin text, p_question uuid,
  p_option uuid default null, p_abstain boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  b public.ballots;
  q public.questions_highest_outright;
  a record;
  v_err text;
  v_sub uuid := gen_random_uuid();
  v_had boolean;
  v_ok  boolean;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Ballot not found.'); end if;

  v_err := public.app_window_error(b);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'closed', true); end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then return jsonb_build_object('ok', false, 'error', a.error); end if;

  select * into q from public.questions_highest_outright
   where id = p_question and ballot_id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Question not found on this ballot.'); end if;
  if not q.enabled then return jsonb_build_object('ok', false, 'error', 'That question is not part of this ballot.'); end if;
  if b.mode = 'gated' and not q.gate_open then
    return jsonb_build_object('ok', false, 'error',
      format('Voting on "%s" is not open. Please wait for the chair.', q.prompt));
  end if;

  if coalesce(p_abstain, false) then
    if not q.allow_abstain then
      return jsonb_build_object('ok', false, 'error', 'This question does not allow abstentions.');
    end if;
    p_option := null;
  else
    if p_option is null then
      return jsonb_build_object('ok', false, 'error', 'Please make a selection.');
    end if;
    select exists (select 1 from public.options_highest_outright o
                    where o.id = p_option and o.question_id = q.id and o.enabled)
      into v_ok;
    if not v_ok then
      return jsonb_build_object('ok', false, 'error', 'That option is not available.');
    end if;
  end if;

  select exists (select 1 from public.votes_highest_outright
                  where question_id = q.id and voter_key = a.voter_key and valid)
    into v_had;

  if v_had and not b.allow_vote_change then
    return jsonb_build_object('ok', false, 'error', b.already_voted_message);
  end if;

  if v_had then
    update public.votes_highest_outright set valid = false
     where question_id = q.id and voter_key = a.voter_key and valid;
  end if;

  insert into public.votes_highest_outright
    (question_id, ballot_id, voter_key, token_id, submission_id, weight, option_id, abstain)
  values
    (q.id, p_ballot, a.voter_key,
     case when b.anonymous then null else a.token_id end,
     v_sub, a.weight, p_option, coalesce(p_abstain, false));

  perform public.app_after_vote(p_ballot, a.token_id, a.voter_key);

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub,
    'question_id', q.id,
    'message', b.thank_you_message,
    'results', case when b.show_results_after
                    then public.question_results(p_ballot, 'highest_outright', q.id) else null end,
    'state', public.voter_state(p_ballot, p_pin, p_fingerprint)
  );
end $$;

-- ------------------------------------------------------ highest X options

create or replace function public.cast_highest_x(
  p_ballot uuid, p_pin text, p_question uuid, p_options uuid[],
  p_fingerprint text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  b public.ballots;
  q public.questions_highest_x;
  a record;
  v_err text;
  v_sub uuid := gen_random_uuid();
  v_had boolean;
  v_chosen uuid[];
  v_count int;
  v_min int;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Ballot not found.'); end if;

  v_err := public.app_window_error(b);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'closed', true); end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then return jsonb_build_object('ok', false, 'error', a.error); end if;

  select * into q from public.questions_highest_x
   where id = p_question and ballot_id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Question not found on this ballot.'); end if;
  if not q.enabled then return jsonb_build_object('ok', false, 'error', 'That question is not part of this ballot.'); end if;
  if b.mode = 'gated' and not q.gate_open then
    return jsonb_build_object('ok', false, 'error',
      format('Voting on "%s" is not open. Please wait for the chair.', q.prompt));
  end if;

  -- Keep only live options of this question, de-duplicated.
  select coalesce(array_agg(distinct o.id), '{}'::uuid[]) into v_chosen
    from public.options_highest_x o
   where o.question_id = q.id and o.enabled
     and o.id = any (coalesce(p_options, '{}'::uuid[]));

  v_count := coalesce(array_length(v_chosen, 1), 0);
  v_min := greatest(q.select_min, 1);

  if v_count < v_min then
    return jsonb_build_object('ok', false, 'error',
      format('Please choose at least %s option(s).', v_min));
  end if;
  if v_count > q.select_max then
    return jsonb_build_object('ok', false, 'error',
      format('Please choose at most %s option(s).', q.select_max));
  end if;

  select exists (select 1 from public.votes_highest_x
                  where question_id = q.id and voter_key = a.voter_key and valid)
    into v_had;

  if v_had and not b.allow_vote_change then
    return jsonb_build_object('ok', false, 'error', b.already_voted_message);
  end if;

  if v_had then
    update public.votes_highest_x set valid = false
     where question_id = q.id and voter_key = a.voter_key and valid;
  end if;

  insert into public.votes_highest_x
    (question_id, ballot_id, voter_key, token_id, submission_id, weight, option_id)
  select q.id, p_ballot, a.voter_key,
         case when b.anonymous then null else a.token_id end,
         v_sub, a.weight, oid
    from unnest(v_chosen) as oid;

  perform public.app_after_vote(p_ballot, a.token_id, a.voter_key);

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub,
    'question_id', q.id,
    'message', b.thank_you_message,
    'results', case when b.show_results_after
                    then public.question_results(p_ballot, 'highest_x', q.id) else null end,
    'state', public.voter_state(p_ballot, p_pin, p_fingerprint)
  );
end $$;
