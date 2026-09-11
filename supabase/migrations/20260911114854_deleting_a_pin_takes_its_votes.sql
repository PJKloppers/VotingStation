-- ============================================================================
-- VotingStation :: deleting a PIN takes its votes with it
--
-- A vote is tied to its PIN by `voter_key`, not by the token id -- on an
-- anonymous ballot `token_id` is null by design, so the foreign key's
-- ON DELETE SET NULL was never the link. Deleting a token therefore used to
-- leave its votes standing and counted, attributed to a voter who no longer
-- existed and could no longer be audited.
--
-- This is the one place the system deletes rather than supersedes. Everywhere
-- else a replaced ballot goes valid = false and the row stays, because the log
-- is the record. But a vote whose PIN has been destroyed cannot be traced back
-- to anything, so keeping it is not keeping a record -- it is keeping a number.
-- reset_token remains the way to void a PIN's votes and keep the trail.
-- ============================================================================

create or replace function app.delete_votes_with_token()
returns trigger language plpgsql security definer set search_path = public as $$
declare k text;
begin
  -- Computed before the row goes; the salt lives on the ballot, and anonymity
  -- cannot change once a vote exists, so this key is the one that was stored.
  k := public.app_voter_key(old.ballot_id, old.pin);

  delete from public.votes_yes_no
   where ballot_id = old.ballot_id and voter_key = k;
  delete from public.votes_highest_outright
   where ballot_id = old.ballot_id and voter_key = k;
  delete from public.votes_highest_x
   where ballot_id = old.ballot_id and voter_key = k;

  return old;
end $$;

create trigger ballot_tokens_delete_votes
  before delete on public.ballot_tokens
  for each row execute function app.delete_votes_with_token();
