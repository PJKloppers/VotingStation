-- ============================================================================
-- VotingStation :: the organizer API and the function grants
--
-- Everything an organizer does to a ballot's *configuration* goes through
-- ordinary PostgREST writes guarded by RLS. Only the things RLS cannot
-- express -- minting PINs, voiding a ballot, closing every gate at once --
-- live here, and each one re-checks ownership itself because a security
-- definer function does not get RLS for free.
-- ============================================================================

create or replace function public.app_require_owner(p_ballot uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.app_owns_ballot(p_ballot) then
    raise exception 'Not your ballot.' using errcode = '42501';
  end if;
end $$;

/* Mints unique 6-digit PINs for one ballot. Existing PINs are never reused. */
create or replace function public.issue_tokens(
  p_ballot uuid, p_count int, p_label_prefix text default null
) returns table (pin text, label text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_want int := least(greatest(coalesce(p_count, 0), 1), 2000);
  v_start int;
  v_made int := 0;
  v_guard int := 0;
  v_pin text;
begin
  perform public.app_require_owner(p_ballot);

  select count(*) into v_start from public.ballot_tokens where ballot_id = p_ballot;

  while v_made < v_want and v_guard < v_want * 200 loop
    v_guard := v_guard + 1;
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');

    begin
      insert into public.ballot_tokens (ballot_id, pin, label)
      values (p_ballot, v_pin,
              case when coalesce(btrim(p_label_prefix), '') = '' then ''
                   else btrim(p_label_prefix) || ' ' || (v_start + v_made + 1)::text end);
      v_made := v_made + 1;
      return query select v_pin,
        case when coalesce(btrim(p_label_prefix), '') = '' then ''
             else btrim(p_label_prefix) || ' ' || (v_start + v_made)::text end;
    exception when unique_violation then
      -- taken on this ballot; draw another
    end;
  end loop;

  if v_made = 0 then
    raise exception 'Could not mint unique PINs for this ballot.';
  end if;
end $$;

/* Frees a PIN to vote again and voids everything it has standing.
   Pass a question to reset just that one. */
create or replace function public.reset_token(
  p_token uuid, p_question uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  t public.ballot_tokens;
  k text;
  n int := 0;
  c int;
begin
  select * into t from public.ballot_tokens where id = p_token;
  if not found then raise exception 'PIN not found.'; end if;
  perform public.app_require_owner(t.ballot_id);

  k := public.app_voter_key(t.ballot_id, t.pin);

  update public.votes_yes_no set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.votes_highest_outright set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.votes_highest_x set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.ballot_tokens
     set questions_voted = public.app_questions_voted(t.ballot_id, k),
         last_vote_at = case when public.app_questions_voted(t.ballot_id, k) = 0
                             then null else last_vote_at end
   where id = p_token;

  return jsonb_build_object('ok', true, 'voided', n);
end $$;

/* Voids every vote on a ballot without touching its questions. */
create or replace function public.clear_ballot_votes(p_ballot uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare n int := 0; c int;
begin
  perform public.app_require_owner(p_ballot);

  update public.votes_yes_no set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_outright set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_x set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;

  update public.ballot_tokens
     set questions_voted = 0, last_vote_at = null
   where ballot_id = p_ballot;

  return jsonb_build_object('ok', true, 'voided', n);
end $$;

create or replace function public.close_all_gates(p_ballot uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.app_require_owner(p_ballot);
  update public.questions_yes_no
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  update public.questions_highest_outright
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  update public.questions_highest_x
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  return jsonb_build_object('ok', true);
end $$;

/* The chair's control: open one gate, or close every gate on the ballot. */
create or replace function public.set_gate(
  p_ballot uuid, p_type text, p_question uuid, p_open boolean,
  p_only boolean default false
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.app_require_owner(p_ballot);

  if p_only then
    perform public.close_all_gates(p_ballot);
  end if;

  if p_type = 'yes_no' then
    update public.questions_yes_no
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  elsif p_type = 'highest_outright' then
    update public.questions_highest_outright
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  elsif p_type = 'highest_x' then
    update public.questions_highest_x
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  else
    raise exception 'Unknown question type %', p_type;
  end if;

  return jsonb_build_object('ok', true);
end $$;

/* The organizer's view of a ballot's PINs, with turnout. */
create or replace function public.ballot_token_report(p_ballot uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.app_require_owner(p_ballot);
  return (
    select jsonb_build_object(
      'issued', count(*)::int,
      'used', count(*) filter (where questions_voted > 0)::int,
      'disabled', count(*) filter (where status = 'disabled')::int,
      'tokens', coalesce(jsonb_agg(jsonb_build_object(
                  'id', id, 'pin', pin, 'label', label, 'status', status,
                  'weight', weight, 'questions_voted', questions_voted,
                  'last_vote_at', last_vote_at) order by issued_at, pin), '[]'::jsonb))
      from public.ballot_tokens where ballot_id = p_ballot
  );
end $$;

-- ============================================================== the grants
-- Everything is private by default; the public surface is listed once, here.

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- helpers the RLS policies themselves call, so every role needs them
grant execute on function public.app_owns_ballot(uuid)      to anon, authenticated;
grant execute on function public.app_ballot_readable(uuid)  to anon, authenticated;
grant execute on function public.app_votes_readable(uuid)   to anon, authenticated;

-- the voter surface
grant execute on function public.voter_state(uuid, text, text)                  to anon, authenticated;
grant execute on function public.cast_yes_no(uuid, text, uuid, text, text)      to anon, authenticated;
grant execute on function public.cast_highest_outright(uuid, text, uuid, uuid, boolean, text) to anon, authenticated;
grant execute on function public.cast_highest_x(uuid, text, uuid, uuid[], text) to anon, authenticated;

-- the public results surface
grant execute on function public.ballot_results(uuid) to anon, authenticated;

-- the organizer surface
grant execute on function public.issue_tokens(uuid, int, text)              to authenticated;
grant execute on function public.reset_token(uuid, uuid)                    to authenticated;
grant execute on function public.clear_ballot_votes(uuid)                   to authenticated;
grant execute on function public.set_gate(uuid, text, uuid, boolean, boolean) to authenticated;
grant execute on function public.close_all_gates(uuid)                      to authenticated;
grant execute on function public.ballot_token_report(uuid)                  to authenticated;
