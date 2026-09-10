-- ============================================================================
-- VotingStation :: tallying
--
-- Nothing is ever incremented. Every number here is derived from the vote
-- tables at the moment it is asked for, so a count cannot drift away from the
-- rows behind it. Superseded ballots (valid = false) are invisible to all of it.
--
-- Each type is tallied by its own rule:
--
--   yes_no            carried when the Yes share clears the question's
--                     fraction of the decisive (non-abstaining) votes
--   highest_outright  the single option with the most votes, optionally
--                     required to clear half of the votes cast
--   highest_x         the top `winner_count` options, with the tie at the
--                     cut-off called out rather than broken arbitrarily
-- ============================================================================

-- ------------------------------------------------------------------ yes/no

create or replace function public.tally_yes_no(p_question uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with t as (
    select
      coalesce(sum(v.weight) filter (where v.choice = 'yes'), 0)::int     as yes,
      coalesce(sum(v.weight) filter (where v.choice = 'no'), 0)::int      as no,
      coalesce(sum(v.weight) filter (where v.choice = 'abstain'), 0)::int as abstain,
      count(distinct v.voter_key)::int                                    as voters
    from public.votes_yes_no v
    where v.question_id = p_question and v.valid
  )
  select jsonb_build_object(
    'yes', t.yes, 'no', t.no, 'abstain', t.abstain,
    'cast', t.yes + t.no + t.abstain,
    'decisive', t.yes + t.no,
    'voters', t.voters,
    'yes_share', case when t.yes + t.no > 0
                      then round(t.yes::numeric / (t.yes + t.no), 4) else null end,
    'threshold', q.pass_num || '/' || q.pass_den,
    'threshold_strict', q.threshold_strict,
    'carried', case
      when t.yes + t.no = 0 then null
      when q.threshold_strict then t.yes * q.pass_den >  q.pass_num * (t.yes + t.no)
      else                        t.yes * q.pass_den >= q.pass_num * (t.yes + t.no)
    end,
    'labels', jsonb_build_object(
      'yes', q.yes_label, 'no', q.no_label, 'abstain', q.abstain_label)
  )
  from t, public.questions_yes_no q
  where q.id = p_question;
$$;

-- -------------------------------------------------------- highest outright

create or replace function public.tally_highest_outright(p_question uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with counted as (
    select o.id, o.label, o.description, o.sort_order,
           coalesce(sum(v.weight), 0)::int as votes
      from public.options_highest_outright o
      left join public.votes_highest_outright v
        on v.option_id = o.id and v.valid
     where o.question_id = p_question and o.enabled
     group by o.id, o.label, o.description, o.sort_order
  ),
  ranked as (
    select c.*, rank() over (order by c.votes desc) as rnk from counted c
  ),
  agg as (
    select coalesce(sum(votes), 0)::int as total,
           coalesce(max(votes), 0)::int as top,
           count(*) filter (where rnk = 1 and votes > 0)::int as leaders
      from ranked
  ),
  extra as (
    select coalesce(sum(v.weight) filter (where v.abstain), 0)::int as abstain,
           count(distinct v.voter_key)::int as voters
      from public.votes_highest_outright v
     where v.question_id = p_question and v.valid
  )
  select jsonb_build_object(
    'total', agg.total,
    'abstain', extra.abstain,
    'voters', extra.voters,
    'require_majority', q.require_majority,
    'tied', agg.leaders > 1,
    'majority_reached', agg.top * 2 > agg.total,
    'winner', case
      when agg.total = 0 or agg.leaders <> 1 then null
      when q.require_majority and agg.top * 2 <= agg.total then null
      else (select to_jsonb(r.id) from ranked r where r.rnk = 1 limit 1)
    end,
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'label', r.label, 'description', r.description,
               'votes', r.votes, 'rank', case when r.votes > 0 then r.rnk else null end,
               'share', case when agg.total > 0
                             then round(r.votes::numeric / agg.total, 4) else 0 end)
             order by r.votes desc, r.label)
        from ranked r), '[]'::jsonb)
  )
  from agg, extra, public.questions_highest_outright q
  where q.id = p_question;
$$;

-- ------------------------------------------------------- highest X options

create or replace function public.tally_highest_x(p_question uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with counted as (
    select o.id, o.label, o.description, o.sort_order,
           coalesce(sum(v.weight), 0)::int as votes
      from public.options_highest_x o
      left join public.votes_highest_x v
        on v.option_id = o.id and v.valid
     where o.question_id = p_question and o.enabled
     group by o.id, o.label, o.description, o.sort_order
  ),
  ranked as (
    select c.*,
           rank() over (order by c.votes desc) as rnk,
           row_number() over (order by c.votes desc, c.label) as seat
      from counted c
  ),
  q as (
    select * from public.questions_highest_x where id = p_question
  ),
  cut as (
    select (select votes from ranked r where r.seat = (select winner_count from q)) as cut_votes
  ),
  agg as (
    select coalesce(sum(votes), 0)::int as total from ranked
  ),
  extra as (
    select count(distinct v.voter_key)::int as voters,
           count(distinct v.submission_id)::int as submissions
      from public.votes_highest_x v
     where v.question_id = p_question and v.valid
  )
  select jsonb_build_object(
    'total', agg.total,
    'voters', extra.voters,
    'submissions', extra.submissions,
    'winner_count', q.winner_count,
    'select_min', q.select_min,
    'select_max', q.select_max,
    -- true when the option just inside the cut-off ties one just outside it
    'tied_at_cut', coalesce(cut.cut_votes, 0) > 0 and exists (
      select 1 from ranked r
       where r.seat > q.winner_count and r.votes = cut.cut_votes),
    'winners', coalesce((
      select jsonb_agg(to_jsonb(r.id) order by r.seat)
        from ranked r
       where r.seat <= q.winner_count and r.votes > 0), '[]'::jsonb),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'label', r.label, 'description', r.description,
               'votes', r.votes, 'rank', case when r.votes > 0 then r.rnk else null end,
               'elected', r.seat <= q.winner_count and r.votes > 0,
               'share', case when extra.voters > 0
                             then round(r.votes::numeric / extra.voters, 4) else 0 end)
             order by r.votes desc, r.label)
        from ranked r), '[]'::jsonb)
  )
  from q, cut, agg, extra;
$$;

-- ------------------------------------------------------------- composition

/* One question's result, wrapped with the header the client renders. Internal:
   the cast_* functions call it for "show results after voting". */
create or replace function public.question_results(
  p_ballot uuid, p_type text, p_question uuid
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if p_type = 'yes_no' then
    select jsonb_build_object('id', q.id, 'type', 'yes_no', 'prompt', q.prompt,
             'description', q.description, 'gate_open', q.gate_open,
             'tally', public.tally_yes_no(q.id))
      into r from public.questions_yes_no q where q.id = p_question and q.ballot_id = p_ballot;

  elsif p_type = 'highest_outright' then
    select jsonb_build_object('id', q.id, 'type', 'highest_outright', 'prompt', q.prompt,
             'description', q.description, 'gate_open', q.gate_open,
             'tally', public.tally_highest_outright(q.id))
      into r from public.questions_highest_outright q where q.id = p_question and q.ballot_id = p_ballot;

  elsif p_type = 'highest_x' then
    select jsonb_build_object('id', q.id, 'type', 'highest_x', 'prompt', q.prompt,
             'description', q.description, 'gate_open', q.gate_open,
             'tally', public.tally_highest_x(q.id))
      into r from public.questions_highest_x q where q.id = p_question and q.ballot_id = p_ballot;
  end if;

  return coalesce(r, 'null'::jsonb);
end $$;

/* The whole ballot, for the public results page. */
create or replace function public.ballot_results(p_ballot uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  b public.ballots;
  v_questions jsonb;
  v_tokens record;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ballot not found.');
  end if;
  if not public.app_votes_readable(p_ballot) then
    return jsonb_build_object('ok', false, 'error', 'This ballot does not publish its results.');
  end if;

  select coalesce(jsonb_agg(
           public.question_results(p_ballot, q.question_type, q.id)
           order by q.sort_order, q.prompt), '[]'::jsonb)
    into v_questions
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled;

  select count(*)::int as issued,
         count(*) filter (where questions_voted > 0)::int as used
    into v_tokens
    from public.ballot_tokens where ballot_id = p_ballot;

  return jsonb_build_object(
    'ok', true,
    'updated', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ballot', jsonb_build_object(
      'id', b.id, 'title', b.title, 'description', b.description,
      'status', b.status, 'mode', b.mode),
    'turnout', jsonb_build_object('issued', v_tokens.issued, 'used', v_tokens.used),
    'questions', v_questions
  );
end $$;
