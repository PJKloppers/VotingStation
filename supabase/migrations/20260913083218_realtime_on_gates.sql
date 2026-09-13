-- ============================================================================
-- VotingStation :: tell the waiting phones when a gate moves
--
-- The waiting screen had a Reload button because nothing told it the chair had
-- opened anything. Polling every few seconds would have worked and was already
-- there as a setting, but it is the wrong shape: two hundred phones on a ten
-- second beat is twenty calls a second for a room where nothing happens for
-- minutes at a time, and it is still up to ten seconds late when it does.
--
-- A gate moving is an UPDATE on a question row, so the phones can be told.
-- Realtime applies row level security per subscriber and these tables read as
-- app.ballot_readable(ballot_id) -- a published ballot's questions are already
-- public, so this exposes nothing a voter could not fetch anyway.
--
-- REPLICA IDENTITY FULL because a gate closing is an UPDATE, and without the
-- whole old row the policy and the client's own ballot filter have nothing to
-- match on.
-- ============================================================================

alter publication supabase_realtime add table public.questions_yes_no;
alter publication supabase_realtime add table public.questions_highest_outright;
alter publication supabase_realtime add table public.questions_highest_x;

alter table public.questions_yes_no           replica identity full;
alter table public.questions_highest_outright replica identity full;
alter table public.questions_highest_x        replica identity full;

-- A ballot being closed, or expiring, is the other thing a waiting phone needs
-- to notice. ballots carries no secret a published row does not already show --
-- the read policy hides drafts, and vote_salt is excluded from every grant.
alter publication supabase_realtime add table public.ballots;
alter table public.ballots replica identity full;
