-- ============================================================================
-- VotingStation :: reach a ballot by its slugs
--
-- A printed slip is read by a person, and `/vote/<uuid>` is not. The pair of
-- slugs is, so `/vote/demo-society/agm-2026` has to resolve to the same ballot
-- the uuid does.
--
-- It cannot be done with a join from the client any more: organizations became
-- owner-only, so an anonymous reader cannot look up an organization by slug.
-- This is the one function that may, and it answers only for a ballot that is
-- published -- or to the owner, so a draft can be checked before it goes out.
-- ============================================================================

create or replace function public.resolve_ballot(
  p_org text, p_ballot text
) returns uuid
language sql stable security definer set search_path = public as $$
  select b.id
    from public.ballots b
    join public.organizations o on o.id = b.org_id
   where lower(btrim(o.slug)) = lower(btrim(coalesce(p_org, '')))
     and lower(btrim(b.slug)) = lower(btrim(coalesce(p_ballot, '')))
     and (b.status <> 'draft' or app.owns_ballot(b.id))
   limit 1;
$$;

revoke all on function public.resolve_ballot(text, text) from public;
grant execute on function public.resolve_ballot(text, text) to anon, authenticated;

/* The slugs for a ballot, so a page can build the readable link for it. */
create or replace function public.ballot_slugs(p_ballot uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case
    when b.status <> 'draft' or app.owns_ballot(b.id)
      then jsonb_build_object('org', o.slug, 'ballot', b.slug)
    else null
  end
    from public.ballots b
    join public.organizations o on o.id = b.org_id
   where b.id = p_ballot;
$$;

revoke all on function public.ballot_slugs(uuid) from public;
grant execute on function public.ballot_slugs(uuid) to anon, authenticated;
