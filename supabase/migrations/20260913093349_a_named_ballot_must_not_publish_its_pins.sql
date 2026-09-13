-- A named ballot was publishing its PINs in plaintext.
--
-- `app_voter_key` returns `'pin:' || p_pin` when `ballots.anonymous` is false,
-- and `voter_key` is an ordinary column of the three vote tables. Their read
-- policy is granted to `public` and opens every row of a question once
-- `app.question_public` passes -- so the moment a chair closed a gate on a
-- results_public ballot, any stranger could select `voter_key` back out and
-- read the six digits. Demonstrated end to end before this was written.
--
-- Attribution is the point of a named ballot; handing out the credential is
-- not. The PIN is what casts a vote, so a published one could be used to
-- answer any other question on that ballot whose gate was still open, or to
-- change its owner's answer where the ballot allows changes.
--
-- The grant has to be rebuilt column by column rather than revoked in place:
-- these tables carry a table-wide SELECT, which covers every column including
-- ones added later, and `revoke select (voter_key)` does not cut into it.
-- Same shape as `ballots.vote_salt`, which is kept off the API the same way.
--
-- What stays readable is the row: a public result is still a public result,
-- and `token_id` still ties one voter's answers together across a named
-- ballot's questions -- it is an opaque id, not a credential, and it is null
-- on an anonymous ballot. Only the PIN goes. Nothing reads this column through
-- the API; every tally is computed inside `question_results`, which is
-- SECURITY DEFINER and so is unaffected by a column grant.
--
-- Being a grant rather than a policy, it cannot be worked around with a forged
-- filter: asking for the column is refused before any row is considered.

revoke select on public.votes_yes_no from anon, authenticated;
revoke select on public.votes_highest_outright from anon, authenticated;
revoke select on public.votes_highest_x from anon, authenticated;

grant select (id, question_id, ballot_id, token_id, submission_id, weight, valid, created_at, choice)
  on public.votes_yes_no to anon, authenticated;
grant select (id, question_id, ballot_id, token_id, submission_id, weight, valid, created_at, option_id, abstain)
  on public.votes_highest_outright to anon, authenticated;
grant select (id, question_id, ballot_id, token_id, submission_id, weight, valid, created_at, option_id)
  on public.votes_highest_x to anon, authenticated;
