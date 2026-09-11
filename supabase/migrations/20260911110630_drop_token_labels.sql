-- ============================================================================
-- VotingStation :: drop token labels
--
-- A label was only ever set by the prefix given when PINs were minted, and
-- nothing could edit one afterwards, so it carried no information the issue
-- order did not already carry. Removing it takes the column with it rather
-- than leaving one that nothing writes and nothing reads.
-- ============================================================================

-- The return type changes, so these have to go and come back.
drop function public.issue_tokens(uuid, int, text);
drop function public.app_authorise(uuid, text, text);

alter table public.ballot_tokens drop column label;

create or replace function public.issue_tokens(
  p_ballot uuid, p_count int
) returns table (pin text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_want int := least(greatest(coalesce(p_count, 0), 1), 2000);
  v_made int := 0;
  v_guard int := 0;
  v_pin text;
begin
  perform public.app_require_owner(p_ballot);

  while v_made < v_want and v_guard < v_want * 200 loop
    v_guard := v_guard + 1;
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.ballot_tokens (ballot_id, pin) values (p_ballot, v_pin);
      v_made := v_made + 1;
      return query select v_pin;
    exception when unique_violation then
      -- taken on this ballot; draw another
    end;
  end loop;

  if v_made = 0 then
    raise exception 'Could not mint unique PINs for this ballot.';
  end if;
end $$;

create or replace function public.app_authorise(
  p_ballot uuid, p_pin text, p_fingerprint text
) returns table (token_id uuid, voter_key text, weight int, error text)
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
    return query select null::uuid, null::text, null::int,
      'Too many incorrect PINs. Please wait 15 minutes and try again.'::text;
    return;
  end if;

  if length(v_pin) <> 6 then
    perform public.app_register_failure(p_ballot, v_fp);
    return query select null::uuid, null::text, null::int, 'A PIN is six digits.'::text;
    return;
  end if;

  select * into v_tok from public.ballot_tokens t
   where t.ballot_id = p_ballot and t.pin = v_pin;

  if not found then
    perform public.app_register_failure(p_ballot, v_fp);
    return query select null::uuid, null::text, null::int,
      'That PIN is not valid. Please check and try again.'::text;
    return;
  end if;

  if v_tok.status = 'disabled' then
    return query select null::uuid, null::text, null::int,
      'That PIN has been disabled. Please contact the organiser.'::text;
    return;
  end if;

  delete from public.pin_attempts pa
   where pa.ballot_id = p_ballot and pa.fingerprint = v_fp;

  return query select
    v_tok.id, public.app_voter_key(p_ballot, v_pin), v_tok.weight, null::text;
end $$;

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
                  'id', id, 'pin', pin, 'status', status,
                  'weight', weight, 'questions_voted', questions_voted,
                  'last_vote_at', last_vote_at) order by issued_at, pin), '[]'::jsonb))
      from public.ballot_tokens where ballot_id = p_ballot
  );
end $$;

revoke all on function public.issue_tokens(uuid, int) from public;
revoke all on function public.app_authorise(uuid, text, text) from public;
grant execute on function public.issue_tokens(uuid, int) to authenticated;
