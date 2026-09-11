-- ============================================================================
-- VotingStation :: the mark travels with the payloads a voter already asks for
--
-- The table it comes from is owner-only, and making a directory of
-- organizations readable again is exactly what was just closed. So the path
-- rides along with voter_state, ballot_results and find_ballots_for_pin.
-- ============================================================================

do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'voter_state';
  if position('org_logo_path' in body) = 0 then
    body := replace(body,
      '''lobby_refresh_seconds'', b.lobby_refresh_seconds' || chr(10) || '    ),',
      '''lobby_refresh_seconds'', b.lobby_refresh_seconds,' || chr(10) ||
      '      ''org_logo_path'', app.ballot_logo_path(b.id)' || chr(10) || '    ),');
    execute body;
  end if;

  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ballot_results';
  if position('org_logo_path' in body) = 0 then
    body := replace(body,
      '''status'', b.status, ''mode'', b.mode),',
      '''status'', b.status, ''mode'', b.mode,' || chr(10) ||
      '      ''org_logo_path'', app.ballot_logo_path(b.id)),');
    execute body;
  end if;

  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'find_ballots_for_pin';
  if position('org_logo_path' in body) = 0 then
    body := replace(body,
      '''org_slug'', o.slug',
      '''org_slug'', o.slug,' || chr(10) ||
      '           ''org_logo_path'', app.ballot_logo_path(b.id)');
    execute body;
  end if;
end $$;
