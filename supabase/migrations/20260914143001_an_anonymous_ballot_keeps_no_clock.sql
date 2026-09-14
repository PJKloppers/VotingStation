-- A timestamp was linking every anonymous vote back to the PIN that cast it.
--
-- app_after_vote set ballot_tokens.last_vote_at = now() in the same
-- transaction as the vote's own created_at default, so the two were identical
-- to the microsecond. Both are readable by the organizer who owns the ballot.
-- Joining one to the other named the voter behind every row -- passively, with
-- one query, altering nothing and leaving no trace.
--
-- The salt never protected against this. It keeps the PIN out of the vote
-- table; it cannot help when a second table is keeping the same clock.
--
-- So an anonymous ballot no longer records when a PIN last voted. Nothing
-- shows it -- the organizer's progress comes from questions_voted, which is a
-- count and links to nothing -- and reset_token already sets it to null.
-- A named ballot keeps it: there the vote is attributable by design.

create or replace function public.app_after_vote(
  p_ballot uuid, p_token uuid, p_voter_key text
) returns void language plpgsql security definer set search_path = public as $function$
declare v_anonymous boolean;
begin
  select anonymous into v_anonymous from public.ballots where id = p_ballot;

  update public.ballot_tokens
     set questions_voted = public.app_questions_voted(p_ballot, p_voter_key),
         last_vote_at = case when v_anonymous then null else now() end
   where id = p_token;
end $function$;

-- and the ones already recorded, which are the same disclosure sitting in the
-- table waiting to be read
update public.ballot_tokens t
   set last_vote_at = null
  from public.ballots b
 where b.id = t.ballot_id and b.anonymous and t.last_vote_at is not null;
