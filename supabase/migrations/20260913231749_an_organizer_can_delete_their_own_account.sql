-- An organizer can close their own account.
--
-- There was no way to. The quota message says "delete one to make room", the
-- privacy page had to admit there was no button anywhere, and an organizer who
-- wanted out had to ask a human. This is the button.
--
-- It takes no arguments, and that is the whole of its security: the only row it
-- can ever delete is auth.uid()'s. There is no target to forge, no id to
-- transpose, and nothing an organizer could pass that would reach another
-- account. Granted to `authenticated` alone -- anonymous callers are refused by
-- the grant, before the body runs.
--
-- SECURITY DEFINER because auth.users belongs to supabase_auth_admin and no
-- organizer has, or should have, delete on it.
--
-- Everything else follows by cascade, which is why this function is one line:
-- organizations from the owner, ballots from the organization, and from a
-- ballot its questions, PINs and votes; organization_images from the
-- organization, whose own trigger then takes the mark out of the bucket.
-- Verified end to end on a throwaway account before this was written -- every
-- one of those counts goes to zero.

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  delete from auth.users where id = me;
end $function$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
