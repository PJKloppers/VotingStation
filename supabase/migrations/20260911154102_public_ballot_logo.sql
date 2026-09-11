-- ============================================================================
-- VotingStation :: the mark, before a PIN is entered
--
-- The voter page shows the ballot's heading before voter_state is reachable,
-- so the mark has to be too. Published ballots only, and it answers with a path
-- into a bucket that is public to read anyway.
-- ============================================================================

create or replace function public.ballot_logo(p_ballot uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.ballots b
                  where b.id = p_ballot and b.status <> 'draft')
      or app.owns_ballot(p_ballot)
    then app.ballot_logo_path(p_ballot)
    else null
  end;
$$;

revoke all on function public.ballot_logo(uuid) from public;
grant execute on function public.ballot_logo(uuid) to anon, authenticated;
