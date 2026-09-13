-- A reusable list of options, belonging to an organization.
--
-- The same twelve names are put to a meeting three times in an evening -- elect
-- a chair, elect a secretary, elect the committee -- and typing them out again
-- each time is where mistakes come from. A pool is that list, kept once.
--
-- It belongs to an organization rather than to a person, because that is what
-- the list is of: this society's members. The quota, though, is counted per
-- person, so spreading pools across organizations does not buy more of them.

create table public.option_pools (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index option_pools_org_idx on public.option_pools (org_id);

create table public.option_pool_entries (
  id          uuid primary key default gen_random_uuid(),
  pool_id     uuid not null references public.option_pools(id) on delete cascade,
  label       text not null check (length(btrim(label)) between 1 and 200),
  description text not null default '',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index option_pool_entries_pool_idx on public.option_pool_entries (pool_id, sort_order);

create trigger option_pools_touch
  before update on public.option_pools
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------- the quota

create or replace function app.max_option_pools_per_user()
returns integer language sql immutable as $function$ select 3 $function$;

create or replace function app.enforce_option_pool_quota()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_owner uuid; v_held int;
begin
  select o.owner_id into v_owner from public.organizations o where o.id = new.org_id;

  -- Counted per person, not per organization: the limit is on the account, so
  -- spreading pools across organizations does not buy more of them.
  select count(*) into v_held
    from public.option_pools p
    join public.organizations o on o.id = p.org_id
   where o.owner_id = v_owner;

  if v_held >= app.max_option_pools_per_user() then
    raise exception 'You may have at most % option pools. Delete one to make room.',
      app.max_option_pools_per_user() using errcode = '23514';
  end if;
  return new;
end $function$;

create trigger option_pools_quota
  before insert on public.option_pools
  for each row execute function app.enforce_option_pool_quota();

-- ------------------------------------------------------------- who may read

create or replace function app.owns_pool(p_pool uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.option_pools p
      join public.organizations o on o.id = p.org_id
     where p.id = p_pool and o.owner_id = auth.uid()
  );
$function$;

alter table public.option_pools enable row level security;
alter table public.option_pool_entries enable row level security;

create policy option_pools_own on public.option_pools
  for all using (app.owns_organization(org_id)) with check (app.owns_organization(org_id));

create policy option_pool_entries_own on public.option_pool_entries
  for all using (app.owns_pool(pool_id)) with check (app.owns_pool(pool_id));

grant select, insert, update, delete on public.option_pools to authenticated;
grant select, insert, update, delete on public.option_pool_entries to authenticated;
