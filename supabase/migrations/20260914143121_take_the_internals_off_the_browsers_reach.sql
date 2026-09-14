-- Three things a browser could reach that it has no business reaching.
--
-- 1. public.app_authorise returns the voter_key -- the pseudonym itself -- and
--    was granted to anon. Anyone holding a PIN could ask for the key its votes
--    are filed under, which is the one value the salt exists to keep out of
--    reach. Nothing in the client calls it; the four SECURITY DEFINER
--    functions that do (the three cast_* and voter_state) run as the definer
--    and are unaffected by the grant.
--
-- 2. app.voters_on returns a set of voter_keys and was executable by PUBLIC,
--    with no ownership check and no gate check of its own. Only PostgREST's
--    schema list stands between it and the world: `app` is not exposed, so it
--    is unreachable today. One config change would publish every named
--    ballot's PINs again -- the exact hole 20260913093349 was written to
--    close. app.voted_on and app.expected_on were PUBLIC on the same terms.
--
-- 3. The vote tables carried Dxtm for anon and authenticated: TRUNCATE,
--    REFERENCES, TRIGGER, MAINTAIN. TRUNCATE is the one that matters, because
--    it does not consult row level security at all -- it empties the table.
--    PostgREST issues no TRUNCATE, so it was not reachable, but a privilege
--    that would be catastrophic if it ever were is not one to leave lying
--    about. These are the residue of Postgres's default privileges in `public`,
--    which grant everything to both roles; rls.sql revoked only insert, update
--    and delete.
--
-- The SELECT column grants are named explicitly rather than revoked and
-- rebuilt, so what a public result publishes is untouched.

revoke all on function public.app_authorise(uuid, text, text) from public, anon, authenticated;

revoke all on function app.voters_on(text, uuid) from public, anon, authenticated;
revoke all on function app.voted_on(text, uuid) from public, anon, authenticated;
revoke all on function app.expected_on(uuid, text, uuid) from public, anon, authenticated;

revoke truncate, references, trigger, maintain
  on public.votes_yes_no, public.votes_highest_outright, public.votes_highest_x
  from anon, authenticated;
