-- ============================================================================
-- VotingStation :: shortening a ballot's life
--
-- An owner may bring a ballot's expiry forward -- ending it sooner is theirs to
-- decide -- but never push it past the retention window. renew_ballot is the
-- sugar for "as far out as it goes"; this is the general form.
--
-- The cap is what keeps the column off the client grants: a browser can ask for
-- any date it likes and still not outlive the policy.
-- ============================================================================

create or replace function public.set_ballot_expiry(
  p_ballot uuid, p_when timestamptz
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_cap timestamptz := now() + app.ballot_retention();
  v_until timestamptz;
begin
  perform public.app_require_owner(p_ballot);

  if p_when is null then
    return jsonb_build_object('ok', false, 'error', 'A date is required.');
  end if;
  if p_when > v_cap then
    return jsonb_build_object('ok', false,
      'error', format('A ballot may not outlive %s from now.', app.ballot_retention()));
  end if;

  update public.ballots set expires_at = p_when
   where id = p_ballot
  returning expires_at into v_until;

  return jsonb_build_object('ok', true, 'expires_at', v_until);
end $$;

revoke all on function public.set_ballot_expiry(uuid, timestamptz) from public;
grant execute on function public.set_ballot_expiry(uuid, timestamptz) to authenticated;

-- The purge runs on a schedule as the database's own job, but an owner may ask
-- for it early; it only ever takes what is already past its date.
grant execute on function public.purge_expired_ballots() to authenticated;
