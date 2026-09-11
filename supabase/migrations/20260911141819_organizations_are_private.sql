-- ============================================================================
-- VotingStation :: an organization is its owner's alone
--
-- `organizations_read_all` was `using (true)`, so every signed-in user could
-- list every other user's organizations -- and the dashboard, which lists the
-- organizations row level security hands it, showed them. It was written for
-- the public directory on the front page; that directory is gone, and the
-- policy should have gone with it.
--
-- Nothing public needs to read this table. A voter reaching a ballot by PIN
-- gets the organization's name from find_ballots_for_pin, and app.owns_ballot
-- joins it -- both security definer, so neither goes through this policy.
--
-- Writes were never affected: the update and delete policies have always been
-- owner-scoped, so a stranger's UPDATE matched no rows. Only reading leaked.
-- ============================================================================

drop policy organizations_read_all on public.organizations;

create policy organizations_read_own on public.organizations
  for select to authenticated
  using (owner_id = auth.uid());
