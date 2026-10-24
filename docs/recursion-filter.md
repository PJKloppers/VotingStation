# Recursion filter ("Narrow it down")

A question type for choosing **one person for a role** from a pool, in stages.
The room nominates, then votes again and again on a shrinking shortlist until
one person is left or someone wins a majority.

There is **no fixed number of rounds**. Each round is the same step applied to
whatever the round before left behind, and it repeats until the vote is decided.

> Design notes and the reasoning behind each choice are in
> [plan-recursion-filter.md](plan-recursion-filter.md).

## How a race runs

```
Nominations (round 0)
   voters name up to N people from the pool
   anyone with enough nominations goes onto the shortlist
        │
        ▼
Round 1, 2, 3 …
   voters choose from whoever is still in
   the chair closes the round and settles it:
     • someone has a majority (if that setting is on) → winner
     • only one person left                           → winner
     • otherwise the lowest X drop out                → next round
```

Every round has its **own gate**. A voter sees the question only while a round
is open, and only the chair opens one. This holds whatever mode the ballot runs in.

## Setting it up (Questions tab)

Add a question and choose **Narrow it down**.

| Setting | What it means | Default |
|---|---|---|
| The pool | The people who can be nominated. Copied into the question, so later changes to the pool don't touch a running vote. | — |
| Nominations per voter | How many names each voter may put forward in round 0 | 1 |
| Nominations needed | How many nominations someone needs to make the shortlist | 1 |
| Pick at least / at most | How many people a voter chooses in each elimination round | 1 / 1 |
| Stop on majority | End early when more than half of a round's voters back one person | on |
| Allow abstain | Lets a voter abstain, with your own label | off |

The pool can be edited until the race starts. After that, use the chair's
controls on the Live tab.

## Running it (Live tab)

Each race has its own panel. The main **next** button on the Live tab also
steps through the rounds: *Close nominations*, *Close round N*, *Settle it
first*, *Open round N*.

| Control | When | What it does |
|---|---|---|
| Open / close the gate | Any round | Opens or closes **the current round** only |
| How many drop out | While the round is open, or closed but not settled | Sets the cut for this round. 0 is allowed (same people vote again); it can never remove everyone |
| Settle | Round closed | Applies the cut and either names the winner or prepares the next round |
| Choose the shortlist myself | Nominations | Skip or override the nomination count and pick who goes through to round 1 |
| Break a tie | When settling asks for it | If the cut falls inside a group with equal votes, you choose who drops |
| Add someone from the pool | Any time | Brings in someone from the pool, or someone who dropped out or withdrew. Added while a round is open, they join **the next** round, because people who already voted never saw them |
| Withdraw | Round closed | Takes someone out of the race. Shown as "withdrew", kept apart from "voted out" |
| End the vote | Round closed | Ends it now, either with a chosen winner or with no winner |

### If nominations come up short

- **Nobody reaches the threshold:** settling refuses. Lower the threshold, add
  people from the pool, or choose the shortlist yourself.
- **Exactly one person qualifies:** end the vote with them as winner, or add
  others before round 1.

## What voters see

- A heading of **Nominations** or **Round N**, never "Round N of M".
- The people they may choose from in that round, and how many to pick.
- Each round starts as a fresh ballot. Their vote in earlier rounds stays on record.
- Between rounds, a waiting screen until the chair opens the next one.

## Results

Results show the race round by round, newest first: the counts, who went out
and why (dropped, tie broken by the chair, withdrew), and how it ended
(majority, last one in, or named by the chair). Like single-winner questions,
counts become public once a round closes. On the Live tab, the chair also sees
who the current drop count *would* remove and any tie at the cut before settling.

## A worked example

Pool of 12. Nominations per voter 3, nominations needed 1, stop on majority on.

| Round | Votes | Chair's drop | Outcome |
|---|---|---|---|
| Nominations | A 14, B 9, C 6, D 2, E 1, seven others 0 | — | A–E go through |
| 1 | A 12, B 9, C 7, D 4, E 4 | 1 | D and E tie at the cut; the chair drops E |
| between rounds | — | — | the chair adds F from the pool |
| 2 | A 13, B 10, C 6, F 4, D 3 | 2 | D and F drop |
| 3 | A 20 of 36 voters | — | A has more than half, so A wins |

## For developers

- Migration: `supabase/migrations/20261023130021_recursion_filter.sql`
- Tables: `questions_recursion_filter`, `options_recursion_filter` (candidates
  and their status: `pool` / `in` / `dropped` / `withdrawn` / `winner`),
  `rounds_recursion_filter` (one row per round; round 0 is nominations),
  `votes_recursion_filter` (votes carry `round_no`).
- The question's `gate_open` mirrors the current round, so shared code keeps
  working without knowing about rounds.
- Race state can only change through the database functions: `cast_recursion_filter`,
  `set_round_drop_count`, `set_round_picks`, `settle_round`, `add_candidate`,
  `withdraw_candidate`, `end_recursion`, plus the shared `set_gate` and
  `advance_ballot`. A trigger refuses direct edits.
- A settled round stores a frozen `outcome` (counts, who dropped, the tie and
  the chair's pick, the winner), so results never change after the fact.
- Frontend: `frontend/src/pages/RecursionControls.tsx` (chair panel),
  `frontend/src/components/RecursionResult.tsx` (results), and branches in
  `Questions.tsx`, `Manage.tsx`, `Vote.tsx`, `Results.tsx` and `Live.tsx`.
