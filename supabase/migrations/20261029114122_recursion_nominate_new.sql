-- ============================================================================
-- VotingStation :: the chair adds a new name to a race that has begun
--
-- Once nominations open, a race's list of people is the engine's: the
-- organizer can no longer insert into it directly. But a name is often
-- called from the floor while nominations are open -- someone who was left
-- off the pool. nominate_new lets the chair add them:
--
--   during nominations   they join the nominations list (status 'pool'), so
--                        voters can nominate them. Anyone who has already
--                        voted never saw them; with vote changes allowed they
--                        can change their nominations.
--   after nominations    they go into the race, exactly as add_candidate puts
--                        someone in from the pool (joining the next round if
--                        the current one is already under way).
--
-- The question row is touched so every voter's screen refreshes at once.
-- Only the ballot's owner may do it.
-- ============================================================================

create function public.nominate_new(p_question uuid, p_label text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  o public.options_recursion_filter;
  v_label text := btrim(coalesce(p_label, ''));
  v_id uuid;
  v_sort int;
  v_answer jsonb;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  if v_label = '' then
    return jsonb_build_object('ok', false, 'error', 'Type the name of the person to add.');
  end if;
  if length(v_label) > 200 then
    return jsonb_build_object('ok', false, 'error', 'That name is too long.');
  end if;

  select * into o from public.options_recursion_filter
   where question_id = q.id and lower(btrim(label)) = lower(v_label);
  if found then
    return jsonb_build_object('ok', false, 'error',
      case when o.status = 'pool' and q.phase = 'nominating'
             then format('%s is already on the nominations list.', o.label)
           when o.status in ('pool', 'dropped', 'withdrawn')
             then format('%s is already on the list: add them from the pool instead.', o.label)
           else format('%s is already in the race.', o.label) end);
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_sort
    from public.options_recursion_filter where question_id = q.id;

  insert into public.options_recursion_filter (question_id, label, sort_order, status, added_by_chair)
  values (q.id, v_label, v_sort, 'pool', true)
  returning id into v_id;

  if q.phase = 'nominating' then
    v_answer := jsonb_build_object('ok', true, 'option_id', v_id,
      'message', case when q.gate_open
                      then format('%s is on the nominations list. Voters can nominate them now.', v_label)
                      else format('%s is on the nominations list.', v_label) end);
  else
    v_answer := public.add_candidate(q.id, v_id) || jsonb_build_object('option_id', v_id);
  end if;

  -- nudge every screen watching the ballot
  update public.questions_recursion_filter set updated_at = now() where id = q.id;
  return v_answer;
end $$;

revoke all on function public.nominate_new(uuid, text) from public, anon;
grant execute on function public.nominate_new(uuid, text) to authenticated;
