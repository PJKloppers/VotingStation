-- ============================================================================
-- VotingStation :: the voter API
--
-- A statically hosted client cannot be trusted with a PIN check, a gate or a
-- selection rule, so every one of them lives here. The anon role may call
-- these functions and nothing else that touches a PIN.
--
-- These functions RETURN their errors rather than raising them. A raise would
-- roll back the failed-attempt counter along with the rest of the statement,
-- which is exactly the write we need to keep.
-- ============================================================================

-- --------------------------------------------------------------- internals

create or replace function public.app_normalise_pin(p_pin text)
returns text language sql immutable as $$
  select regexp_replace(coalesce(p_pin, ''), '\D', '', 'g');
$$;

create or replace function public.app_voter_key(p_ballot uuid, p_pin text)
returns text language sql stable security definer
set search_path = public, extensions as $$
  select case
    when b.anonymous
      then left(encode(extensions.digest(p_pin || '|' || b.vote_salt::text, 'sha256'), 'hex'), 32)
    else 'pin:' || p_pin
  end
  from public.ballots b where b.id = p_ballot;
$$;

-- Switching a ballot between named and anonymous mid-count would strand every
-- key already recorded, so it is refused once a vote exists.
create or replace function public.app_guard_anonymity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.anonymous is distinct from old.anonymous
     and exists (select 1 from public.votes_yes_no where ballot_id = new.id
                 union all select 1 from public.votes_highest_outright where ballot_id = new.id
                 union all select 1 from public.votes_highest_x where ballot_id = new.id)
  then
    raise exception 'Anonymity cannot be changed once votes have been cast.';
  end if;
  return new;
end $$;

create trigger ballots_guard_anonymity before update on public.ballots
  for each row execute function public.app_guard_anonymity();

/* Whether the ballot accepts votes right now. Returns null when it does. */
create or replace function public.app_window_error(b public.ballots)
returns text language sql stable as $$
  select case
    when b.status = 'draft'  then 'This ballot has not been published yet.'
    when b.status = 'closed' then b.closed_message
    when b.opens_at is not null and now() < b.opens_at
      then 'Voting opens ' || to_char(b.opens_at, 'DD Mon YYYY HH24:MI') || '.'
    when b.closes_at is not null and now() > b.closes_at
      then 'Voting closed ' || to_char(b.closes_at, 'DD Mon YYYY HH24:MI') || '.'
    else null
  end;
$$;

/* How many distinct questions this voter has a standing ballot on. */
create or replace function public.app_questions_voted(p_ballot uuid, p_voter_key text)
returns int language sql stable security definer set search_path = public as $$
  select (
      (select count(distinct question_id) from public.votes_yes_no
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
    + (select count(distinct question_id) from public.votes_highest_outright
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
    + (select count(distinct question_id) from public.votes_highest_x
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
  )::int;
$$;

-- ------------------------------------------------------- PIN authorisation

create or replace function public.app_register_failure(p_ballot uuid, p_fingerprint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pin_attempts (ballot_id, fingerprint, failures, first_at)
  values (p_ballot, p_fingerprint, 1, now())
  on conflict (ballot_id, fingerprint) do update
    set failures = case when public.pin_attempts.first_at < now() - interval '15 minutes'
                        then 1 else public.pin_attempts.failures + 1 end,
        first_at = case when public.pin_attempts.first_at < now() - interval '15 minutes'
                        then now() else public.pin_attempts.first_at end,
        locked_until = case when public.pin_attempts.failures + 1 >= 12
                            then now() + interval '15 minutes' else null end;
end $$;

/*
 * Resolves a PIN to its token row.
 *
 * Returns (token_id, voter_key, label, weight, error). `error` non-null means
 * the caller must stop and hand that message back to the voter. Only genuine
 * failures feed the lock-out, so a voter refreshing the waiting screen for an
 * hour is never shut out of their own ballot.
 */
create or replace function public.app_authorise(
  p_ballot uuid, p_pin text, p_fingerprint text
) returns table (token_id uuid, voter_key text, label text, weight int, error text)
language plpgsql security definer set search_path = public as $$
declare
  v_pin text := public.app_normalise_pin(p_pin);
  v_tok public.ballot_tokens;
  v_locked timestamptz;
  v_fp text := coalesce(nullif(btrim(p_fingerprint), ''), 'anon');
begin
  select pa.locked_until into v_locked
    from public.pin_attempts pa
   where pa.ballot_id = p_ballot and pa.fingerprint = v_fp;

  if v_locked is not null and v_locked > now() then
    return query select null::uuid, null::text, null::text, null::int,
      'Too many incorrect PINs. Please wait 15 minutes and try again.'::text;
    return;
  end if;

  if length(v_pin) <> 6 then
    perform public.app_register_failure(p_ballot, v_fp);
    return query select null::uuid, null::text, null::text, null::int,
      'A PIN is six digits.'::text;
    return;
  end if;

  select * into v_tok from public.ballot_tokens t
   where t.ballot_id = p_ballot and t.pin = v_pin;

  if not found then
    perform public.app_register_failure(p_ballot, v_fp);
    return query select null::uuid, null::text, null::text, null::int,
      'That PIN is not valid. Please check and try again.'::text;
    return;
  end if;

  if v_tok.status = 'disabled' then
    return query select null::uuid, null::text, null::text, null::int,
      'That PIN has been disabled. Please contact the organiser.'::text;
    return;
  end if;

  delete from public.pin_attempts pa
   where pa.ballot_id = p_ballot and pa.fingerprint = v_fp;

  return query select
    v_tok.id,
    public.app_voter_key(p_ballot, v_pin),
    v_tok.label,
    v_tok.weight,
    null::text;
end $$;

-- ------------------------------------------------------ the waiting screen

/*
 * One call drives every reload: which questions are live, which this voter
 * has already answered, what they answered, and how far along they are.
 */
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
    'voter', jsonb_build_object('label', a.label, 'weight', a.weight),
    'progress', jsonb_build_object(
      'voted', public.app_questions_voted(p_ballot, a.voter_key),
      'open_now', jsonb_array_length(v_questions),
      'total', v_total
    ),
    'questions', v_questions
  );
end $$;
