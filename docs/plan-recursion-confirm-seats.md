# Plan: the chair confirms the seats before round 1

Status: **applied to the database** (`supabase/migrations/20261028202111_recursion_confirm_seats.sql`); frontend built locally, not committed.

## What changes

The seat count is set when the question is added, but the chair only knows
the real number once nominations are in: how many people made the shortlist,
and how many seats the meeting decides to fill. So between **settling
nominations** and **opening round 1**, the chair's panel asks one question:

> **How many seats are being filled?**  `[ 10 ]`
> 18 on the shortlist. Each voter will have up to 10 votes in round 1.
> **[Confirm 10 seats]**

- The box is **prefilled** with the number from the question. Confirming it
  unchanged is one click.
- **Round 1 will not open until the seats are confirmed.** The database
  refuses it, not only the screen.
- **The number can be changed** until round 1 opens: "10 seats · Change".
  After that it is fixed.
- **1 makes it a chairperson race; more makes it a committee.** The choice is
  made here, with the shortlist in front of the chair.
- **The hint warns** when the shortlist is no bigger than the seats: "7 people
  for 7 seats: there is nothing to vote on. Settling round 1 elects them all."

## Database (migration)

| Change | Detail |
|---|---|
| `questions_recursion_filter.seats_confirmed boolean not null default false` | Set only by the round functions (added to the trigger's engine-only columns). Existing races already past nominations are marked confirmed, so nothing running is blocked. |
| `set_race_seats(p_question, p_seats)` | Chair only. Allowed only after nominations and before round 1 opens: current round 1, not opened, no votes, nobody elected. Sets `seats`, marks them confirmed, and resets round 1: `seats_open`, plus `pick_max` (one per seat, or the question's own picks for one seat). It answers with a sentence for the panel. |
| `app.rf_set_gate` | Refuses to open round 1 until the seats are confirmed: "Confirm how many seats "…" fills before opening round 1." |
| `settle_round` | Settling round 1 (for example "elect them all") also needs confirmed seats: `{ ok: false, needs: 'seats' }`. |
| `tally_recursion_filter_race` | Adds `seats_confirmed`, so the panel knows which step to show. |
| `clear_ballot_votes` | Resets `seats_confirmed` with the rest of the race. |
| Grants | `set_race_seats` goes to `authenticated` only; anon gets nothing. |

The floor button (`advance_ballot`) is unchanged. Opening round 1 through it
gets the same refusal, and the floor card says to confirm the seats first.

## Screens

| Where | Change |
|---|---|
| Chair's panel, round 1 before it opens | The seats question replaces "Open round 1" until it is confirmed. Then "Open round 1" is shown, with "10 seats · Change". |
| Floor card | "Chairperson: confirm the seats below before round 1", and its button says "Confirm the seats first" instead of trying to open the round. |
| Questions tab | The seats field's help text: "You confirm this after nominations, before round 1." |

## Tests

- **Database dry run:** opening round 1 unconfirmed is refused; confirming
  works; a stranger and anon are refused; changing seats after round 1 opens is
  refused; changing 10 to 1 turns it into a chairperson race.
- **Integration (`recursion-seats.test.ts`):** the same checks against the live
  database, with both races confirming before round 1.
- **Browser:** the three race tests confirm the seats before round 1. The
  committee test first types 3, checks the hint, changes it to 4 and confirms,
  then checks "4 seats · Change" and the new "Open round 1".
