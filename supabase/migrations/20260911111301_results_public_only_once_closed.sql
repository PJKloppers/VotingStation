-- ============================================================================
-- VotingStation :: no public tally while the vote is running
--
-- A running count changes how people vote. Until the ballot closes the tally
-- belongs to the organizer alone; afterwards it is public, as before, if the
-- ballot publishes its results at all.
--
-- This one function is the whole rule. It guards the read policy on all three
-- vote tables -- which is also what Realtime checks per subscriber, so nobody
-- can watch the votes arrive either -- and it guards ballot_results.
--
-- Two things deliberately still work while a ballot is live:
--   * the owner reads everything, which is what the live monitor uses;
--   * "show the result after voting" still reaches question_results directly.
-- ============================================================================

create or replace function app.votes_readable(p_ballot uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ballots b
     where b.id = p_ballot and b.status = 'closed' and b.results_public
  ) or app.owns_ballot(p_ballot);
$$;
