-- ============================================================================
-- VotingStation :: an organization's own page, and the end of the global lookup
--
-- A scanned code may carry one slug or two. Two go straight to a ballot; one
-- lands on the organization, which needs to be able to show what it has
-- published -- and organizations are owner-only, so this is the one function
-- that may read one by slug. It answers with published ballots only.
--
-- And find_ballots_for_pin goes. It existed because the front page took a PIN
-- with no idea which ballot it belonged to, which meant one guess probed every
-- published ballot at once. A voter now arrives at the ballot before entering a
-- code, so a code only has to be unique where it is used -- which it already
-- was, `unique (ballot_id, pin)` -- and nothing has to search for it. That is
-- what lets far more than a million codes exist across the system.
-- ============================================================================

create or replace function public.org_ballots(p_org text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'org', jsonb_build_object(
      'slug', o.slug,
      'name', o.name,
      'description', o.description,
      'logo_path', (select i.path from public.organization_images i
                     where i.org_id = o.id and i.kind = 'logo')),
    'ballots', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'slug', b.slug, 'title', b.title,
               'description', b.description, 'status', b.status,
               'results_public', b.results_public)
             order by b.created_at desc)
        from public.ballots b
       where b.org_id = o.id and b.status <> 'draft'), '[]'::jsonb)
  )
  from public.organizations o
  where lower(btrim(o.slug)) = lower(btrim(coalesce(p_org, '')));
$$;

revoke all on function public.org_ballots(text) from public;
grant execute on function public.org_ballots(text) to anon, authenticated;

drop function if exists public.find_ballots_for_pin(text, text);
drop table if exists public.pin_lookups;
