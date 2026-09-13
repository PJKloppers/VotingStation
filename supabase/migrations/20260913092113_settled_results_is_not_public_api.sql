-- Two internal helpers were on the public API surface, and one of them took the
-- caller's word for the row it was meant to be checking.
--
-- `organizer_api.sql` revokes execute from the world in a loop, and then
-- `20260911113640` created these two afterwards -- so they kept Postgres's
-- default of EXECUTE TO PUBLIC and PostgREST published them as RPCs.
--
-- `app_settled_results` is SECURITY DEFINER and receives the ballot as a
-- composite *by value*. Every publicity check it makes -- show_results_after,
-- and status/mode by way of app_question_settled -- reads that argument, so an
-- anonymous caller who sent a made-up row with a real ballot's id and
-- status => 'closed' was answered with the tally of a live, gated question
-- whose gate was still open. Verified against the deploy before this ran.
--
-- Neither function is called by the client; both are only ever reached from
-- SECURITY DEFINER functions (voter_state, and the three cast_*), which run as
-- the definer and so are untouched by the revoke.

revoke all on function public.app_settled_results(public.ballots, text)
  from public, anon, authenticated;
revoke all on function public.app_question_settled(public.ballots, boolean)
  from public, anon, authenticated;

-- Belt as well as braces: read the ballot the id names rather than trusting the
-- copy handed in, so the checks below are made against the real row even if a
-- future grant puts this function back within reach.
create or replace function public.app_settled_results(b public.ballots, p_voter_key text)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare v jsonb;
begin
  select * into b from public.ballots where id = b.id;
  if not found then return '[]'::jsonb; end if;
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
end $function$;

-- create or replace resets the ACL to the default, so revoke again after it.
revoke all on function public.app_settled_results(public.ballots, text)
  from public, anon, authenticated;
