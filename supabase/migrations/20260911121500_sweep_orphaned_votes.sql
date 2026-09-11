-- ============================================================================
-- VotingStation :: clear out votes whose PIN is already gone
--
-- The trigger that takes a PIN's votes with it was added after some PINs had
-- already been deleted, so their votes were left behind: counted, attributable
-- to nobody, and -- worse than cosmetic -- counted by app.voted_on, where they
-- could satisfy "all PINs must vote" on behalf of voters who no longer exist.
-- The Live tab showed it plainly as "5 of 4 PINs voted".
--
-- A vote belongs to a PIN by voter_key, so an orphan is one whose key matches
-- no token on its own ballot. One sweep; the trigger keeps it true from here.
-- ============================================================================

delete from public.votes_yes_no v
 where not exists (
   select 1 from public.ballot_tokens t
    where t.ballot_id = v.ballot_id
      and public.app_voter_key(t.ballot_id, t.pin) = v.voter_key);

delete from public.votes_highest_outright v
 where not exists (
   select 1 from public.ballot_tokens t
    where t.ballot_id = v.ballot_id
      and public.app_voter_key(t.ballot_id, t.pin) = v.voter_key);

delete from public.votes_highest_x v
 where not exists (
   select 1 from public.ballot_tokens t
    where t.ballot_id = v.ballot_id
      and public.app_voter_key(t.ballot_id, t.pin) = v.voter_key);

-- The per-token counter is derived, so rebuild it from what is left.
update public.ballot_tokens t
   set questions_voted = public.app_questions_voted(
         t.ballot_id, public.app_voter_key(t.ballot_id, t.pin));
