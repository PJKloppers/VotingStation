-- The "On the ballot" switch is gone from the question editor.
--
-- It let an organizer keep a question in the list but leave it out of the
-- vote -- a draft question, in effect. Nothing used it: no question on this
-- database had ever been switched off, and a ballot that is not live already
-- shows nobody anything, which is the same thing by a simpler route.
--
-- With the control gone the state has to go too. A question left switched off
-- would vanish from the chair's list, from the voter's page and from the
-- count, with nothing in the app able to bring it back -- so the column is
-- pinned true rather than left as a trap for whatever writes it next.
--
-- The column itself stays. Nine functions read `q.enabled`, and a filter that
-- is always true costs nothing; rewriting all nine to drop a word would be a
-- far larger change than this one. If the feature is ever wanted back, these
-- three constraints are what to drop.
--
-- Options are untouched: enabling and disabling an option is still a thing the
-- organizer does, and it still has a button.

update public.questions_yes_no set enabled = true where not enabled;
update public.questions_highest_outright set enabled = true where not enabled;
update public.questions_highest_x set enabled = true where not enabled;

alter table public.questions_yes_no
  add constraint questions_yes_no_always_enabled check (enabled);
alter table public.questions_highest_outright
  add constraint questions_highest_outright_always_enabled check (enabled);
alter table public.questions_highest_x
  add constraint questions_highest_x_always_enabled check (enabled);
