-- ============================================================================
-- VotingStation :: the waiting screen no longer has a button to press
--
-- The default text told a voter to reload when the chair opened the vote.
-- There is nothing to reload now -- the page is told when a gate moves and
-- opens the question itself -- so the default stops naming a button that is
-- not there.
--
-- Only the default changes. A ballot whose organizer wrote their own message
-- keeps it; a ballot still carrying the old default is brought along, since
-- that text is now simply wrong.
-- ============================================================================

alter table public.ballots
  alter column waiting_message
  set default 'No question is open yet. This page will open one as soon as the chair does.';

update public.ballots
   set waiting_message = 'No question is open yet. This page will open one as soon as the chair does.'
 where waiting_message = 'No question is open yet. Reload when the chair opens the vote.';
