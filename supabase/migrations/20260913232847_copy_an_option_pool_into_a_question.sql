-- Copying a pool's entries onto a question.
--
-- A copy, not a link: once the entries are options they belong to the question,
-- and editing the pool afterwards does not reach back into a ballot that may
-- already have votes on it. That is the whole point of doing it this way.
--
-- Appended rather than replacing: an organizer who has already typed two names
-- and then copies a pool wants three, not the pool alone. The sort order
-- carries on from whatever is there.

create or replace function public.copy_pool_into_question(
  p_pool uuid, p_type text, p_question uuid
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_ballot uuid; v_from int; v_added int;
begin
  if not app.owns_pool(p_pool) then
    raise exception 'Not your option pool.' using errcode = '42501';
  end if;

  if p_type = 'highest_outright' then
    select ballot_id into v_ballot from public.questions_highest_outright where id = p_question;
  elsif p_type = 'highest_x' then
    select ballot_id into v_ballot from public.questions_highest_x where id = p_question;
  else
    raise exception 'A % question has no options to copy into.', p_type using errcode = '22023';
  end if;

  if v_ballot is null or not app.owns_ballot(v_ballot) then
    raise exception 'Not your question.' using errcode = '42501';
  end if;

  if p_type = 'highest_outright' then
    select coalesce(max(sort_order), 0) into v_from
      from public.options_highest_outright where question_id = p_question;

    insert into public.options_highest_outright (question_id, label, description, sort_order)
    select p_question, e.label, e.description,
           v_from + row_number() over (order by e.sort_order, e.label)
      from public.option_pool_entries e where e.pool_id = p_pool;
  else
    select coalesce(max(sort_order), 0) into v_from
      from public.options_highest_x where question_id = p_question;

    insert into public.options_highest_x (question_id, label, description, sort_order)
    select p_question, e.label, e.description,
           v_from + row_number() over (order by e.sort_order, e.label)
      from public.option_pool_entries e where e.pool_id = p_pool;
  end if;

  get diagnostics v_added = row_count;
  return v_added;
end $function$;

revoke all on function public.copy_pool_into_question(uuid, text, uuid) from public, anon;
grant execute on function public.copy_pool_into_question(uuid, text, uuid) to authenticated;

-- the dashboard prints "2 of 3"; the number has to come from the same place the
-- trigger reads it, not from a constant typed into the client
create or replace function public.app_limits()
returns jsonb language sql stable set search_path = public as $function$
  select jsonb_build_object(
    'organizations_per_user',   app.max_organizations_per_user(),
    'ballots_per_organization', app.max_ballots_per_organization(),
    'option_pools_per_user',    app.max_option_pools_per_user()
  );
$function$;

revoke all on function public.app_limits() from public;
grant execute on function public.app_limits() to anon, authenticated;
