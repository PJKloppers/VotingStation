-- Whether an organization slug is free, asked before the form is submitted.
--
-- It has to be a function: organizations are owner-only, so a client querying
-- the table sees its own and nothing else, and the one slug that matters --
-- somebody else's -- is invisible until the insert fails on it.
--
-- This tells a signed-in organizer that a slug exists, which is not a leak:
-- slugs are already public by design. They are printed on every slip, they are
-- half of /vote/<org>/<ballot>, and org_ballots() already answers for any slug
-- from anyone. Nothing is learned here that a printed ticket does not say.
--
-- Only the existence of the slug is returned -- never whose it is, nor the
-- organization's name.

create or replace function public.organization_slug_available(p_slug text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select not exists (
    select 1 from public.organizations o where o.slug = lower(btrim(p_slug))
  );
$function$;

revoke all on function public.organization_slug_available(text) from public, anon;
grant execute on function public.organization_slug_available(text) to authenticated;
