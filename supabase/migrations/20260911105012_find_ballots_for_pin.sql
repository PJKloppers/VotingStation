-- ============================================================================
-- VotingStation :: find the ballot a PIN belongs to
--
-- A PIN is unique per ballot, not globally, so a voter who arrives at the front
-- page holding only a PIN has to be told which ballot it opens. This is the one
-- place that answers that question.
--
-- It does widen the guessing surface: one guess now probes every published
-- ballot at once rather than one. The lock-out below is the counterweight --
-- twelve failed lookups per browser per fifteen minutes, and only failures
-- count -- and the answer carries nothing a voter could not already read off
-- the public directory: a ballot's title and whose it is.
-- ============================================================================

create table public.pin_lookups (
  fingerprint  text primary key,
  failures     int not null default 0,
  first_at     timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.pin_lookups enable row level security;
revoke all on public.pin_lookups from anon, authenticated;

comment on table public.pin_lookups is
  'Failed ballot lookups per browser. RLS is on with no policy on purpose: no role holds a grant, so only the security definer function below reaches it.';

create or replace function public.find_ballots_for_pin(
  p_pin text, p_fingerprint text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_pin text := public.app_normalise_pin(p_pin);
  v_fp  text := coalesce(nullif(btrim(p_fingerprint), ''), 'anon');
  v_locked timestamptz;
  v_found jsonb;
begin
  select l.locked_until into v_locked from public.pin_lookups l where l.fingerprint = v_fp;
  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('ok', false,
      'error', 'Too many incorrect PINs. Please wait 15 minutes and try again.');
  end if;

  -- A malformed PIN is a typo, not a guess, so it does not count against them.
  if length(v_pin) <> 6 then
    return jsonb_build_object('ok', false, 'error', 'A PIN is six digits.');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'ballot_id', b.id,
           'title', b.title,
           'status', b.status,
           'org_name', o.name,
           'org_slug', o.slug
         ) order by o.name, b.title), '[]'::jsonb)
    into v_found
    from public.ballot_tokens t
    join public.ballots b on b.id = t.ballot_id
    join public.organizations o on o.id = b.org_id
   where t.pin = v_pin and b.status <> 'draft';

  if jsonb_array_length(v_found) = 0 then
    insert into public.pin_lookups (fingerprint, failures, first_at)
    values (v_fp, 1, now())
    on conflict (fingerprint) do update
      set failures = case when public.pin_lookups.first_at < now() - interval '15 minutes'
                          then 1 else public.pin_lookups.failures + 1 end,
          first_at = case when public.pin_lookups.first_at < now() - interval '15 minutes'
                          then now() else public.pin_lookups.first_at end,
          locked_until = case when public.pin_lookups.failures + 1 >= 12
                              then now() + interval '15 minutes' else null end;

    return jsonb_build_object('ok', false,
      'error', 'That PIN is not valid on any open ballot. Please check and try again.');
  end if;

  delete from public.pin_lookups l where l.fingerprint = v_fp;
  return jsonb_build_object('ok', true, 'ballots', v_found);
end $$;

revoke all on function public.find_ballots_for_pin(text, text) from public;
grant execute on function public.find_ballots_for_pin(text, text) to anon, authenticated;
