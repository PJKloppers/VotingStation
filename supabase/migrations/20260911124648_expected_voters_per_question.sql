-- ============================================================================
-- VotingStation :: who is actually being waited for
--
-- "All PINs must vote" compared two counts that disagreed about who was in the
-- room. The numerator counted every standing vote on the question; the
-- denominator counted active PINs. So disabling a PIN that had already voted
-- shrank the denominator while its vote stayed in the numerator, and the rule
-- was satisfied on behalf of someone who had been removed -- letting the chair
-- step past a question the one remaining voter had never answered.
--
-- The denominator has to be per question, not per ballot: the set of people
-- whose answer is expected on *this* question. That is the active PINs, plus
-- any PIN that has already answered it -- a disabled voter's vote still counts
-- in the tally, so it must still count here, or turnout and tally would say
-- different things about the same ballot.
--
-- A PIN disabled before answering is simply not waited for, which is the point
-- of disabling it.
-- ============================================================================

create or replace function app.voters_on(p_type text, p_question uuid)
returns table (voter_key text)
language sql stable security definer set search_path = public as $$
  select distinct v.voter_key from public.votes_yes_no v
   where p_type = 'yes_no' and v.question_id = p_question and v.valid
  union
  select distinct v.voter_key from public.votes_highest_outright v
   where p_type = 'highest_outright' and v.question_id = p_question and v.valid
  union
  select distinct v.voter_key from public.votes_highest_x v
   where p_type = 'highest_x' and v.question_id = p_question and v.valid;
$$;

create or replace function app.voted_on(p_type text, p_question uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from app.voters_on(p_type, p_question);
$$;

/* Active PINs, plus any PIN that has already answered this question. */
create or replace function app.expected_on(
  p_ballot uuid, p_type text, p_question uuid
) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
    from public.ballot_tokens t
   where t.ballot_id = p_ballot
     and (
       t.status = 'active'
       or public.app_voter_key(t.ballot_id, t.pin)
            in (select voter_key from app.voters_on(p_type, p_question))
     );
$$;

grant execute on function app.voters_on(text, uuid)         to authenticated;
grant execute on function app.voted_on(text, uuid)          to authenticated;
grant execute on function app.expected_on(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------- the step button

do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'advance_ballot';

  if position('expected_on' in body) = 0 then
    body := replace(body,
      'v_due   := app.eligible_pins(p_ballot);',
      'v_due   := app.expected_on(p_ballot, v_open.question_type, v_open.id);');
    execute body;
  end if;
end $$;

-- ------------------------------------------------------ and what a card reports

create or replace function public.question_results(
  p_ballot uuid, p_type text, p_question uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; q record;
begin
  if p_type = 'yes_no' then
    select id, prompt, description, gate_open into q
      from public.questions_yes_no where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_yes_no(q.id)); end if;
  elsif p_type = 'highest_outright' then
    select id, prompt, description, gate_open into q
      from public.questions_highest_outright where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_highest_outright(q.id)); end if;
  elsif p_type = 'highest_x' then
    select id, prompt, description, gate_open into q
      from public.questions_highest_x where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_highest_x(q.id)); end if;
  end if;

  if r is null then return 'null'::jsonb; end if;

  return r || jsonb_build_object(
    'id', q.id, 'type', p_type, 'prompt', q.prompt,
    'description', q.description, 'gate_open', q.gate_open,
    -- how much of the room this question is still waiting on
    'voted', app.voted_on(p_type, p_question),
    'expected', app.expected_on(p_ballot, p_type, p_question));
end $$;
