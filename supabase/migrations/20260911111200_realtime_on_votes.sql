-- ============================================================================
-- VotingStation :: publish vote changes for the live monitor
--
-- The monitor does not read the tally off these events -- it uses them only as
-- a signal to re-ask ballot_results, which stays the single place a count is
-- derived. So what matters is that an event arrives, not what it carries.
--
-- Realtime applies row level security to each subscriber, so nothing new is
-- exposed: the read policy on these tables is app.votes_readable(ballot_id).
--
-- REPLICA IDENTITY FULL so an UPDATE carries the whole old row. A replaced vote
-- is an UPDATE setting valid = false, and without it the old record would
-- arrive without the ballot_id the policy and the client filter both need.
-- ============================================================================

alter publication supabase_realtime add table public.votes_yes_no;
alter publication supabase_realtime add table public.votes_highest_outright;
alter publication supabase_realtime add table public.votes_highest_x;

alter table public.votes_yes_no           replica identity full;
alter table public.votes_highest_outright replica identity full;
alter table public.votes_highest_x        replica identity full;
