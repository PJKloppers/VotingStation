# Plan: more than one seat in a recursion filter

Status: **built.** Database: `supabase/migrations/20261028193205_recursion_filter_seats.sql` (applied). Frontend: the settle dialog and seats in `RecursionControls.tsx`, `RecursionResult.tsx`, `Questions.tsx`, `Vote.tsx`. Tests: `tests/integration/recursion-seats.test.ts`, `tests/e2e/recursion-committee.test.ts`.

## What it does

"Narrow it down" today fills **one** seat. This lets it fill **several**, for
example a committee of 10, using the same cycle of rounds:

1. **Nominations.** Voters nominate. Anyone who reaches the threshold makes
   the shortlist.
2. **Each round.** Every voter has as many votes as there are **seats still
   open**. Anyone backed by **more than half** of the round's voters is
   **elected on the spot**. They leave the race, and their seats are no longer
   open.
3. **The next round** opens for the people still in. Voters now have fewer
   votes, one per seat left.
4. **It ends** when every seat is filled. When the number of people left equals
   the number of seats left, they are all elected and there is no vote.

### The example

10 seats, 20 people nominated.

| Round | Seats open | Votes each | What happens |
|---|---|---|---|
| 1 | 10 | 10 | 5 people are backed by more than half the voters, so all 5 are elected. 15 are still in. |
| 2 | 5 | 5 | 2 more get a majority and are elected. The chair drops the lowest 4. 9 are still in. |
| 3 | 3 | 3 | Nobody gets a majority. The chair drops the lowest 3. 6 are still in. |
| 4 | 3 | 3 | 3 get a majority and are elected. All 10 seats are filled, so it ends. |

As before, **nobody sets the number of rounds**. Each round elects whoever has a
majority, drops whoever the chair cuts, and repeats.

## Design: the same question type, with a seat count

This is not a new type. `recursion_filter` gets a **`seats`** setting, default 1:

- **`seats = 1`** behaves exactly as now: a majority wins, or the last one in
  wins. Existing races are unchanged.
- **`seats > 1`** is the committee mode described above.

One type means one set of tables, one chair panel and one voter screen. The
single-seat race is just the case where one seat is open.

## The rules in a round (settling)

When the chair settles an elimination round:

1. **Who has a majority?** That is anyone whose votes are more than half of
   the voters who voted in this round. Abstainers are not counted (see
   question 4).
2. **Elect them**, up to the number of seats open.
   - If more people have a majority than there are seats, the ones with the
     most votes take the seats.
   - If the last seat falls on a tie, the chair chooses, just as the chair now
     breaks a tie at the cut (see question 2).
3. **Seats left = 0:** the vote is decided.
4. **People left ≤ seats left:** everyone left is elected, and the vote is
   decided. If there are fewer people than seats, the remaining seats stay
   empty and the results say so. The chair can add from the pool before
   settling to avoid that.
5. **Otherwise, the chair says how people drop out.** This is asked every
   round, when settling (see "The drop-off question" below). It applies only to
   the people who weren't elected, and it can never leave fewer people than
   seats left.
6. **The next round opens** with **votes per voter = seats left**.

The chair sees all of this **before** settling, in the same preview that now
shows "would drop": who **would be elected**, who would drop, and any tie at
the seat line or at the cut.

## The drop-off question (asked after every round)

Pressing **Settle round N** doesn't settle straight away. It first opens a
short question for the chair, showing the round's counts:

> **How do people drop out of round N?**
> - **Everyone with ___ votes or fewer.** Ties are never a problem: equal votes
>   are always treated the same.
> - **The lowest ___ people.** As now. If the cut falls on a tie, the chair
>   chooses who goes.
> - **Nobody drops this round.** The same people vote again.

- **Asked every round.** It is prefilled with the previous round's choice, but
  the chair has to confirm it, and nothing settles without an answer.
- **Live preview.** As the chair types, the counts mark who **would be
  elected** and who **would drop**, with a line such as "4 drop, 9 stay for 3
  seats".
- **Guard.** If the answer would leave fewer people than seats left, it is
  refused, and the dialog says how many would remain. Example: "This drops 8
  and leaves 2 for 3 seats. Lower the number."
- **Recorded.** The round's `outcome` stores the rule and its number, so the
  results can say "Round 2: everyone on 3 votes or fewer dropped".
- **Same for one seat.** One-seat races get the same question.
- **The drop count field goes.** The "How many drop out" field on the panel is
  replaced by this question, so the chair answers it in one place, at the
  moment it matters. The chair can still answer early while the round is open,
  to watch the preview, but settling always asks for confirmation.

## Schema changes

| Table | Change |
|---|---|
| `questions_recursion_filter` | `seats int not null default 1 check (seats >= 1)`. Its existing `stop_on_majority` setting becomes **"Elect anyone with a majority"**: if it's off, seats are filled only by narrowing down until the people left equal the seats left. |
| `options_recursion_filter` | New status **`elected`**, plus `elected_round int` and `seat_no int` (the order seats were filled: earlier round first, then more votes). The old status `winner` is read as `elected`. |
| `rounds_recursion_filter` | `seats_open int`: the seats open when the round was created. `pick_max` defaults to it. Also `drop_rule text check (drop_rule in ('count', 'votes', 'none'))` and `drop_votes int`, set beside the existing `drop_count`. The round's `outcome` also records who was elected and the drop rule used. |
| `questions_recursion_filter.winner_id` | Kept for one-seat races. For committees, the elected list is the candidates with status `elected`, ordered by `seat_no`. |

Nothing changes for votes. A voter still casts one row per person chosen, and
the uniqueness rule already allows several per round.

## Functions to change

| Function | Change |
|---|---|
| `tally_recursion_filter` | Adds `seats_open`, the majority list (`elect`), any tie at the seat line, and the drop projection worked out after electing |
| `settle_round` | Follows the steps above. Takes `p_seat_tie uuid[]` for a tie at the seat line, as `p_tie_drop` already works for a tie at the cut |
| `app.rf_next_round` | Sets the new round's `seats_open` and `pick_max` from the seats left |
| `set_round_picks` | Caps `pick_max` at the seats open |
| `set_round_drop_count` → `set_round_drop(p_question, p_rule, p_n)` | Sets the rule (`count`, `votes` or `none`) and its number. It refuses an answer that would leave fewer people than seats left. The old function stays as a thin wrapper for `count` |
| `settle_round` (again) | Refuses to settle until the round has a drop rule (`needs: 'drop_rule'`). A `votes` rule drops everyone at or below the number, so it never needs a tie-break |
| `end_recursion` | Takes a **list** of people to elect, up to the seats left, or none to end with seats empty |
| `cast_recursion_filter` | No change: it already checks picks between `pick_min` and `pick_max` for the round |
| `voter_state` | Sends `seats_open` so the screen can say "Choose up to 5 · 5 seats left" |
| `question_results`, `app_settled_results` | Show the elected list in seat order |
| `withdraw_candidate` | Unchanged for people still in. An elected person who declines is a later step (see question 6) |

## Screens

| Page | Change |
|---|---|
| Questions tab | **How many seats?** (default 1). With more than 1: nominations per voter defaults to the seat count, and the setting reads **"Elect anyone with a majority"** |
| Live tab, chair's panel | A **Seats** line, e.g. "5 of 10 filled", listing who was elected in which round. **Settle** opens the drop-off question, with its live preview of **"would be elected"** and **"would drop"**. There is a seat-line tie picker beside the cut tie picker. **End the vote** becomes a multi-select: "Fill the remaining seats with…" |
| Voter screen | "Round 2 · 5 seats left · choose up to 5". People already elected are not listed |
| Results | **The committee**: elected names in seat order, each with the round they were elected in, then the rounds as now |

## Tests

- **Database (rolled back):** your example of 10 seats and 20 people, with 5
  elected in round 1. Then a round where more people have a majority than there
  are seats; a tie at the seat line; a round with no majority, so a drop; and an
  ending where the people left equal the seats left.
- **Browser:** the two-race room test, extended. *Committee* has 5 seats and
  12 voters, running alongside a one-seat race. Check that each phone shows the
  right number of votes per round, and that elected people disappear from the
  next round.
- **Regression:** an existing one-seat race gives identical results before and
  after.

## Decisions

1. **Votes per voter: up to the seats left.** With 5 seats left, a voter
   chooses 1 to 5 people. Nobody is forced to back people they don't want.
2. **More people with a majority than seats left:** the most votes take the
   seats, and the chair breaks a tie at the seat line.
3. **A round where nobody gets a majority:** the chair drops the lowest X (0 is
   allowed), and the room votes again with the same seats open.
4. **What "majority" counts against:** more than half of the people who voted
   in that round. Abstainers are not counted.
5. **Dropping in the same round as electing:** allowed. The drop-off question
   is still asked, and "Nobody drops" is a valid answer.
6. **An elected person who declines:** a later step. The chair would reopen
   the seat, and it goes back into the seats left.
7. **How people drop out is asked after every round:** "X votes or fewer", "the
   lowest N" or "nobody". It is prefilled from the round before, but must be
   confirmed before the round settles.
