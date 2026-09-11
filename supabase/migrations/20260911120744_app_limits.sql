-- ============================================================================
-- VotingStation :: the quotas, readable by the page that enforces them
--
-- The numbers live in app.max_organizations_per_user() and
-- app.max_ballots_per_organization(), and `app` is deliberately off PostgREST
-- so the machinery behind the policies is not an API. But a form that says
-- "4 of 5 organizations" has to get the 5 from somewhere, and a constant typed
-- into the client is exactly the thing that drifts from the database it is
-- describing.
--
-- So: one public function that reads them. It exposes two integers that the
-- error messages already spell out to anyone who hits the limit.
-- ============================================================================

create or replace function public.app_limits()
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'organizations_per_user',   app.max_organizations_per_user(),
    'ballots_per_organization', app.max_ballots_per_organization()
  );
$$;

revoke all on function public.app_limits() from public;
grant execute on function public.app_limits() to anon, authenticated;
