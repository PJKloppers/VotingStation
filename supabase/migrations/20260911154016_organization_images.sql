-- ============================================================================
-- VotingStation :: an organization's mark
--
-- The image lives in storage; this table is the record of which object belongs
-- to which organization, and the only thing the app ever looks up. Storage
-- paths are `<org id>/<uuid>.<ext>`, so the folder is the ownership check for
-- the bucket policies below.
--
-- The bucket is public to read, because a voter has to see the mark on a ballot
-- without holding an account, and a signed URL per slip on a printed sheet is
-- not a thing that can work. Nothing identifying is in the object beyond the
-- logo an organization chose to publish.
--
-- The table itself is owner-only. What a voter needs -- the path -- reaches
-- them through the security definer functions they already call, so there is no
-- need to make a directory of organizations readable again.
-- ============================================================================

create table public.organization_images (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  kind         text not null default 'logo' check (kind in ('logo')),
  bucket       text not null default 'org-logos',
  path         text not null,
  content_type text not null default 'image/png',
  bytes        int,
  width        int,
  height       int,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One mark of each kind per organization; replacing it replaces the row.
  unique (org_id, kind)
);

create index organization_images_org_idx on public.organization_images (org_id);

create trigger organization_images_touch before update on public.organization_images
  for each row execute function public.touch_updated_at();

comment on table public.organization_images is
  'Which storage object is an organization''s mark. Owner-only; voters get the path from voter_state and friends.';

create or replace function app.owns_organization(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org and o.owner_id = auth.uid()
  );
$$;

grant execute on function app.owns_organization(uuid) to anon, authenticated;

alter table public.organization_images enable row level security;
revoke all on public.organization_images from anon;
grant select, insert, update, delete on public.organization_images to authenticated;

create policy organization_images_owner_all on public.organization_images
  for all to authenticated
  using (app.owns_organization(org_id))
  with check (app.owns_organization(org_id));

-- --------------------------------------------------------------- the bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-logos', 'org-logos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may read; only the organization that owns the folder may write to it.
drop policy if exists org_logos_read   on storage.objects;
drop policy if exists org_logos_write  on storage.objects;
drop policy if exists org_logos_update on storage.objects;
drop policy if exists org_logos_delete on storage.objects;

create policy org_logos_read on storage.objects
  for select using (bucket_id = 'org-logos');

create policy org_logos_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'org-logos'
    and app.owns_organization(((storage.foldername(name))[1])::uuid)
  );

create policy org_logos_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'org-logos'
    and app.owns_organization(((storage.foldername(name))[1])::uuid)
  );

create policy org_logos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'org-logos'
    and app.owns_organization(((storage.foldername(name))[1])::uuid)
  );

-- ------------------------------------------------- what a voter gets to see

/* The mark on the organization behind a ballot, or null. */
create or replace function app.ballot_logo_path(p_ballot uuid)
returns text language sql stable security definer set search_path = public as $$
  select i.path
    from public.ballots b
    join public.organization_images i on i.org_id = b.org_id and i.kind = 'logo'
   where b.id = p_ballot;
$$;

grant execute on function app.ballot_logo_path(uuid) to anon, authenticated;
