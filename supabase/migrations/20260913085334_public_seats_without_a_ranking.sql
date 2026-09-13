-- ============================================================================
-- VotingStation :: the public sees who was elected, not how everyone placed
--
-- An X-of-N election published in full is a public ranking of everyone who
-- stood, with the losers' counts beside their names. The outcome is who took
-- the seats; the rest is a league table nobody consented to.
--
-- So to anyone who is not the ballot's owner, such a question reports the
-- elected and nothing else -- no counts, no shares, no also-rans -- and in a
-- random order, because listing them by votes descending is the ranking again
-- by other means.
--
-- The organizer still sees everything, which is what the live monitor is for,
-- and what they need to settle a tie at the cut-off. Yes/no and
-- highest-outright are unchanged: a motion's numbers are the point of it, and
-- an outright contest has one winner and no seat line to hide.
-- ============================================================================

/* The same question, with the ranking taken out of it. */
create or replace function public.tally_highest_x_public(p_question uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with full_count as (select public.tally_highest_x(p_question) as t),
  elected as (
    select e.value as option
      from full_count, jsonb_array_elements((full_count.t) -> 'options') as e(value)
     where (e.value ->> 'elected')::boolean
     -- Random, because votes-descending is the same ranking by other means.
     order by random()
  )
  select jsonb_build_object(
    'redacted', true,
    'voters', (t -> 'voters'),
    'winner_count', (t -> 'winner_count'),
    'select_min', (t -> 'select_min'),
    'select_max', (t -> 'select_max'),
    'tied_at_cut', (t -> 'tied_at_cut'),
    'total', null,
    'submissions', (t -> 'submissions'),
    'winners', coalesce((select jsonb_agg(option -> 'id') from elected), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', option -> 'id',
               'label', option -> 'label',
               'description', option -> 'description',
               'elected', true,
               'votes', null,
               'rank', null,
               'share', null))
        from elected), '[]'::jsonb)
  )
  from full_count;
$$;

revoke all on function public.tally_highest_x_public(uuid) from public, anon, authenticated;

create or replace function public.question_results(
  p_ballot uuid, p_type text, p_question uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
  q record;
  v_mine boolean := app.owns_ballot(p_ballot);
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
    if found then
      r := jsonb_build_object('tally', case
        when v_mine then public.tally_highest_x(q.id)
        else public.tally_highest_x_public(q.id)
      end);
    end if;
  end if;

  if r is null then return 'null'::jsonb; end if;

  return r || jsonb_build_object(
    'id', q.id, 'type', p_type, 'prompt', q.prompt,
    'description', q.description, 'gate_open', q.gate_open,
    -- how much of the room this question is still waiting on
    'voted', app.voted_on(p_type, p_question),
    'expected', app.expected_on(p_ballot, p_type, p_question));
end $$;
