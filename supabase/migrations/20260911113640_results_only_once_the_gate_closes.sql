-- ============================================================================
-- VotingStation :: a voter sees a result only once that question is finished
--
-- "Show the result after voting" used to hand back the tally with the receipt.
-- But in gated mode the gate is necessarily open at the moment a vote is cast
-- -- cast_* refuses it otherwise -- so that receipt was always a running count
-- of a question other people were still answering.
--
-- A question is finished when it can no longer take a vote: its gate is closed
-- in gated mode, or the whole ballot is closed. Until then there is nothing to
-- show, so the result moves out of the receipt and into the waiting screen,
-- where it appears when the chair closes the question.
-- ============================================================================

create or replace function public.app_question_settled(
  b public.ballots, p_gate_open boolean
) returns boolean language sql stable set search_path = public as $$
  select b.status = 'closed' or (b.mode = 'gated' and not p_gate_open);
$$;

/* Everything this voter has answered that is now finished, with its tally.
   Empty unless the ballot chooses to show voters their results at all. */
create or replace function public.app_settled_results(
  b public.ballots, p_voter_key text
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not b.show_results_after then return '[]'::jsonb; end if;

  with answered as (
    select q.id, 'yes_no'::text as t, q.sort_order, q.prompt, q.gate_open
      from public.questions_yes_no q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_yes_no v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
    union all
    select q.id, 'highest_outright', q.sort_order, q.prompt, q.gate_open
      from public.questions_highest_outright q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_highest_outright v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
    union all
    select q.id, 'highest_x', q.sort_order, q.prompt, q.gate_open
      from public.questions_highest_x q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_highest_x v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
  )
  select coalesce(jsonb_agg(public.question_results(b.id, a.t, a.id)
                            order by a.sort_order, a.prompt), '[]'::jsonb)
    into v
    from answered a
   where public.app_question_settled(b, a.gate_open);

  return v;
end $$;
