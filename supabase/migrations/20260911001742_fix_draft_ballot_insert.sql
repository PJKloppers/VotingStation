-- ============================================================================
-- VotingStation :: let an organizer create a draft ballot
--
-- `ballots_read_public` asked app.owns_ballot(id), which looks the row up in
-- `ballots` -- and during INSERT ... RETURNING the row being inserted is not
-- visible to that lookup, so the check failed and Postgres refused the insert
-- outright. Every ballot starts as a draft, so the organizer's "New ballot"
-- button could never work.
--
-- The fix is to ask the question of the row itself: a policy already has the
-- new row's `org_id` in hand, so ownership is one join to `organizations` and
-- needs no second look at `ballots`. That is also strictly cheaper.
--
-- app.owns_ballot stays for the child tables, where the parent ballot genuinely
-- pre-exists and the lookup is the only way to reach it.
-- ============================================================================

drop policy ballots_read_public on public.ballots;
drop policy ballots_update_own  on public.ballots;
drop policy ballots_delete_own  on public.ballots;

create policy ballots_read_public on public.ballots
  for select using (
    status <> 'draft'
    or exists (select 1 from public.organizations o
                where o.id = org_id and o.owner_id = auth.uid())
  );

create policy ballots_update_own on public.ballots
  for update to authenticated
  using (exists (select 1 from public.organizations o
                  where o.id = org_id and o.owner_id = auth.uid()))
  with check (exists (select 1 from public.organizations o
                       where o.id = org_id and o.owner_id = auth.uid()));

create policy ballots_delete_own on public.ballots
  for delete to authenticated
  using (exists (select 1 from public.organizations o
                  where o.id = org_id and o.owner_id = auth.uid()));
