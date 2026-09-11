-- ============================================================================
-- VotingStation :: how long a ballot lives, and how many there may be
--
-- The three numbers live in one place each, as functions rather than literals
-- scattered through triggers and defaults, so changing a limit is one edit.
-- ============================================================================

create or replace function app.ballot_retention() returns interval
language sql immutable as $$ select interval '30 days' $$;

create or replace function app.max_organizations_per_user() returns int
language sql immutable as $$ select 5 $$;

create or replace function app.max_ballots_per_organization() returns int
language sql immutable as $$ select 20 $$;

grant execute on function app.ballot_retention() to anon, authenticated;
grant execute on function app.max_organizations_per_user() to anon, authenticated;
grant execute on function app.max_ballots_per_organization() to anon, authenticated;

-- --------------------------------------------------------------- expiry

alter table public.ballots
  add column expires_at timestamptz not null default (now() + app.ballot_retention());

-- Existing ballots keep the clock they would have had.
update public.ballots set expires_at = created_at + app.ballot_retention();

create index ballots_expiry_idx on public.ballots (expires_at);

comment on column public.ballots.expires_at is
  'When the purge takes this ballot. Set on creation and pushed out by renew_ballot.';

-- Readable, but not writable from a client: the expiry moves only through
-- renew_ballot and set_ballot_expiry, both of which cap it.
grant select (expires_at) on public.ballots to anon, authenticated;

/* A ballot stops taking votes the moment it expires, rather than whenever the
   purge next happens to run. */
create or replace function public.app_window_error(b public.ballots)
returns text language sql stable set search_path = public as $$
  select case
    when b.status = 'draft'  then 'This ballot has not been published yet.'
    when b.status = 'closed' then b.closed_message
    when b.expires_at <= now() then 'This ballot has expired.'
    when b.opens_at is not null and now() < b.opens_at
      then 'Voting opens ' || to_char(b.opens_at, 'DD Mon YYYY HH24:MI') || '.'
    when b.closes_at is not null and now() > b.closes_at
      then 'Voting closed ' || to_char(b.closes_at, 'DD Mon YYYY HH24:MI') || '.'
    else null
  end;
$$;

/* Pushes the clock out from now. The owner's escape hatch from the purge. */
create or replace function public.renew_ballot(p_ballot uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_until timestamptz;
begin
  perform public.app_require_owner(p_ballot);
  update public.ballots
     set expires_at = now() + app.ballot_retention()
   where id = p_ballot
  returning expires_at into v_until;
  return jsonb_build_object('ok', true, 'expires_at', v_until);
end $$;

revoke all on function public.renew_ballot(uuid) from public;
grant execute on function public.renew_ballot(uuid) to authenticated;

-- ------------------------------------------------------------- the purge

create table public.purge_log (
  id         bigserial primary key,
  ran_at     timestamptz not null default now(),
  ballots    int not null,
  detail     jsonb not null default '[]'::jsonb
);

alter table public.purge_log enable row level security;
revoke all on public.purge_log from anon, authenticated;

comment on table public.purge_log is
  'What the purge took, and when. An automated irreversible job should leave a receipt.';

/* Deletes every ballot past its expiry. Everything below a ballot -- questions,
   options, PINs, votes -- goes with it on the cascades already in place. */
create or replace function public.purge_expired_ballots()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_taken jsonb;
  v_count int;
begin
  with doomed as (
    delete from public.ballots
     where expires_at <= now()
    returning id, org_id, title, created_at, expires_at
  )
  select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb), count(*)
    into v_taken, v_count
    from doomed d;

  if v_count > 0 then
    insert into public.purge_log (ballots, detail) values (v_count, v_taken);
  end if;

  return jsonb_build_object('ok', true, 'ballots', v_count);
end $$;

revoke all on function public.purge_expired_ballots() from public, anon, authenticated;

-- ------------------------------------------------------------- the quotas

create or replace function app.enforce_organization_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_held int;
begin
  select count(*) into v_held from public.organizations where owner_id = new.owner_id;
  if v_held >= app.max_organizations_per_user() then
    raise exception 'You may have at most % organizations. Delete one to make room.',
      app.max_organizations_per_user() using errcode = '23514';
  end if;
  return new;
end $$;

create trigger organizations_quota before insert on public.organizations
  for each row execute function app.enforce_organization_quota();

create or replace function app.enforce_ballot_quota()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_held int;
begin
  select count(*) into v_held from public.ballots where org_id = new.org_id;
  if v_held >= app.max_ballots_per_organization() then
    raise exception 'An organization may hold at most % ballots. Delete one to make room.',
      app.max_ballots_per_organization() using errcode = '23514';
  end if;
  return new;
end $$;

create trigger ballots_quota before insert on public.ballots
  for each row execute function app.enforce_ballot_quota();
