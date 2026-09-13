-- An organization's mark no longer outlives the row that names it.
--
-- The rows already cascaded: organizations to ballots, a ballot to its
-- questions, PINs and votes, and organization_images from the organization.
-- What stayed was the object in the bucket. The row naming it disappeared, so
-- nothing in the app could see it or remove it ever again, and it sat in
-- storage for good. Three such files had already collected this way.
--
-- Two paths lose a mark, and only one of them is a delete. Deleting an
-- organization cascades the image row away; replacing a mark upserts it, which
-- is an update, and leaves the old object behind. Both are covered here, by one
-- function on two triggers, because the client is not the place for this: a
-- cascade runs no client code at all.
--
-- Storage refuses direct deletes from its own tables (storage.protect_delete)
-- and offers one way past, a setting it reads on the way through. It is set
-- with is_local => true, so it holds for this transaction and nothing else.
-- Without it the exception propagates and the organization cannot be deleted at
-- all -- which is exactly how the first version of this behaved, and why the
-- delete is now exercised against a real mark before it is believed.
--
-- The work is wrapped besides, because tidying up after a delete must never be
-- the reason the delete fails. If storage changes its guard again the organizer
-- still loses their organization; what they keep is an unreferenced file, which
-- is much the lesser of the two.
--
-- SECURITY DEFINER because storage.objects belongs to the storage role and an
-- organizer has no business writing it. Granted to nobody: a trigger function
-- is called by the system, not by a caller.
--
-- What goes is storage's record of the object, which is what makes it gone to
-- every reader and to the bucket's own listing. The client asks storage to
-- remove the file first, which is what lets the service reclaim the bytes; this
-- is the backstop for every path that does not.

create or replace function app.delete_stored_image()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare gone text;
begin
  if tg_op = 'DELETE' then
    gone := old.path;
  elsif new.path is distinct from old.path then
    gone := old.path;
  end if;

  if gone is not null then
    begin
      perform set_config('storage.allow_delete_query', 'true', true);
      delete from storage.objects where bucket_id = old.bucket and name = gone;
      perform set_config('storage.allow_delete_query', 'false', true);
    exception when others then
      null;
    end;
  end if;

  return case tg_op when 'DELETE' then old else new end;
end $function$;

revoke all on function app.delete_stored_image() from public, anon, authenticated;

create trigger organization_images_delete_object
  after delete on public.organization_images
  for each row execute function app.delete_stored_image();

create trigger organization_images_replace_object
  after update on public.organization_images
  for each row execute function app.delete_stored_image();
