-- ============================================================================
-- VotingStation :: removing or renaming a name on a race that has begun
--
-- Once nominations open, the race's list is the engine's, and the editor's
-- Remove / rename went nowhere: row security hid the rows, so the delete or
-- update touched nothing and said nothing. These two functions do it for the
-- chair instead, and say what happened.
--
-- remove_race_option
--   before the race begins   the name is deleted
--   during nominations       deleted, if nobody has nominated them; if
--                            someone has, they are withdrawn instead, so the
--                            votes stay on the record but no longer count
--   after nominations        withdrawn, as withdraw_candidate does
--
-- rename_race_option         a typo fixed, at any time before it is decided
--
-- Both touch the question row so every screen on the ballot refreshes.
-- ============================================================================

create function public.remove_race_option(p_question uuid, p_option uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  o public.options_recursion_filter;
  n int;
  v_answer jsonb;
begin
  q := app.rf_question_for_chair(p_question);
  select * into o from public.options_recursion_filter
   where id = p_option and question_id = q.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That name is not on this race.');
  end if;

  if not app.rf_started(q.id) then
    delete from public.options_recursion_filter where id = o.id;
    return jsonb_build_object('ok', true, 'removed', 'deleted',
      'message', format('%s is removed.', o.label));
  end if;
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  if o.status not in ('pool', 'in') then
    return jsonb_build_object('ok', false, 'error', format('%s is already out of the race.', o.label));
  end if;

  if q.phase = 'nominating' then
    select count(*) into n from public.votes_recursion_filter
     where question_id = q.id and option_id = o.id and valid;
    if exists (select 1 from public.votes_recursion_filter where option_id = o.id) then
      update public.options_recursion_filter
         set status = 'withdrawn', dropped_round = 0
       where id = o.id;
      v_answer := jsonb_build_object('ok', true, 'removed', 'withdrawn',
        'message', case when n = 0 then format('%s is removed from the nominations.', o.label)
                        else format('%s is removed from the nominations. Their %s nomination%s no longer count%s.',
                                    o.label, n, case when n = 1 then '' else 's' end,
                                    case when n = 1 then 's' else '' end) end);
    else
      delete from public.options_recursion_filter where id = o.id;
      v_answer := jsonb_build_object('ok', true, 'removed', 'deleted',
        'message', format('%s is removed from the nominations.', o.label));
    end if;
  else
    v_answer := public.withdraw_candidate(q.id, o.id);
    if (v_answer->>'ok')::boolean then
      v_answer := v_answer || jsonb_build_object('removed', 'withdrawn',
        'message', format('%s is withdrawn from the race.', o.label));
    end if;
  end if;

  update public.questions_recursion_filter set updated_at = now() where id = q.id;
  return v_answer;
end $$;

create function public.rename_race_option(p_question uuid, p_option uuid, p_label text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  o public.options_recursion_filter;
  v_label text := btrim(coalesce(p_label, ''));
begin
  q := app.rf_question_for_chair(p_question);
  select * into o from public.options_recursion_filter
   where id = p_option and question_id = q.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That name is not on this race.');
  end if;
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  if v_label = '' then
    return jsonb_build_object('ok', false, 'error', 'A name cannot be blank.');
  end if;
  if length(v_label) > 200 then
    return jsonb_build_object('ok', false, 'error', 'That name is too long.');
  end if;
  if exists (select 1 from public.options_recursion_filter
              where question_id = q.id and id <> o.id and lower(btrim(label)) = lower(v_label)) then
    return jsonb_build_object('ok', false, 'error', format('%s is already on the list.', v_label));
  end if;
  update public.options_recursion_filter set label = v_label where id = o.id;
  update public.questions_recursion_filter set updated_at = now() where id = q.id;
  return jsonb_build_object('ok', true, 'message', format('Renamed to %s.', v_label));
end $$;

revoke all on function public.remove_race_option(uuid, uuid) from public, anon;
revoke all on function public.rename_race_option(uuid, uuid, text) from public, anon;
grant execute on function public.remove_race_option(uuid, uuid) to authenticated;
grant execute on function public.rename_race_option(uuid, uuid, text) to authenticated;
