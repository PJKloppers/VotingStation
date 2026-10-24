# Plan: the `recursion_filter` question type

Status: **built.** Database: `supabase/migrations/20261023130021_recursion_filter.sql` (applied). Frontend: `RecursionControls.tsx`, `RecursionResult.tsx` and branches in the existing pages.

## What it does

Choosing one person for a role from a pool, in stages.

1. **Nomination (round 0).** Voters nominate up to `nominate_max` people from
   the pool. Anyone with at least `nominate_threshold` nominations (default 1)
   goes onto the shortlist.
2. **Elimination (rounds 1, 2, 3 …).** Voters vote on whoever is still in.
   When the round closes, the chair decides how many drop out, and the bottom
   ones go. The next round opens with the people who are left.
3. **The end.** It ends when one person is left. If the question has
   `stop_on_majority` on, it also ends early when someone gets more than half
   the votes in a round.

What the chair can do:

- **Open and close the gate of every round separately**, the same way they open
  and close a question today.
- **Set the drop count for each round**, any time while the round is open or
  before it is settled.
- **Set how many people a voter may pick in each round.** The question holds a
  default, and each round can override it.
- **Break a tie at the cut-off.** If the cut falls inside a group with equal
  votes, the chair picks who drops.
- **Add someone from the pool at any stage.** They join the next round to open.

### No fixed number of rounds

This is the reason the type is called a recursion filter. Nobody sets the
number of rounds up front, and nothing stores one. Each round is the same step
applied to whatever comes out of the round before it:

```
settle(round n):
  if one candidate is left, or someone has a majority (when stop_on_majority is on):
      winner; stop
  else:
      open round n+1 with whoever is still in
```

The only thing that stops it is that condition. So:

- **No `max_rounds` column, and no "round 2 of 5" anywhere.** The screens say
  "Round 2" and nothing more. The number of rounds is known only once the vote ends.
- **The number of rounds can't be worked out in advance.** The chair picks the
  drop count each round, and can add people from the pool between rounds, so
  the race can shrink fast, shrink slowly, or grow.
- **A drop count of 0 is allowed.** The same people go to another round, for
  example after the chair adds someone or when the room wants to vote again.
  The limit is the other way: the drop count can never remove everyone.
- **Rounds are rows, not columns.** `rounds_recursion_filter` gets a new row
  each time, and votes carry `round_no`, so round 40 works the same as round 1.
- **The chair can always stop it.** Since the database won't end the vote by
  itself, the chair can declare the current leader the winner, or end the
  question with no winner. Either choice is recorded in that round's `outcome`.

### A worked example

Pool of 12. `nominate_max = 3`, `nominate_threshold = 1`, `stop_on_majority = on`.

| Round | Gate | Votes | Chair's drop | Outcome |
|---|---|---|---|---|
| 0 Nomination | open → closed | A 14, B 9, C 6, D 2, E 1, seven others 0 | — | A–E shortlisted (≥1) |
| 1 | open → closed | A 12, B 9, C 7, D 4, E 4 | 1 | D and E are tied at the cut. **The chair drops E.** |
| — | between rounds | — | — | Chair adds F from the pool |
| 2 | open → closed | A 13, B 10, C 6, D 3, F 4 | 2 | D and C drop |
| 3 | open → closed | A 20 of 36 voters | — | A has more than half, so A wins |

## How it fits the current design

The README's rule still holds: the new type gets its own tables, a
`question_types` row, a `ballot_questions` branch, and its own `cast_` and
`tally_` functions. What is new is that **one question runs through many
rounds**, and each round has its own gate.

The question's own `gate_open` is kept as a **mirror of the current round's
gate**. That way `ballot_questions`, realtime, `app_question_settled` and the
voter page keep working without knowing about rounds.

This type always runs on its own round gates, whatever the ballot's mode: a
voter sees it only while a round is open, and only the chair can open one.

## Schema

### `questions_recursion_filter`

The common columns, plus:

| Column | Meaning |
|---|---|
| `pool_id` uuid → `option_pools`, on delete set null | where candidates come from |
| `nominate_max` int default 1 | names per voter in round 0 |
| `nominate_threshold` int default 1 | nominations needed to make the shortlist |
| `pick_min` / `pick_max` int default 1 / 1 | default picks per voter in an elimination round |
| `stop_on_majority` bool default true | end early when more than half of a round's voters back one person |
| `allow_abstain` bool default false, `abstain_label` text default 'Abstain' | as in the other types |
| `current_round` int default 0 | |
| `phase` text: `nominating` / `eliminating` / `decided` | |
| `winner_id` uuid → candidate, nullable | |

### `options_recursion_filter` (the candidates)

These are copied from the pool when the question is created. They are copies, so
a later change to the pool doesn't rewrite a running vote.

| Column | Meaning |
|---|---|
| `label`, `description`, `sort_order`, `enabled` | as in the other option tables |
| `pool_entry_id` uuid, nullable | which pool row it came from |
| `status` text: `pool` / `in` / `dropped` / `withdrawn` / `winner` | |
| `joined_round` int, nullable | the round they entered the race |
| `dropped_round` int, nullable | |
| `added_by_chair` bool | true when the chair added them instead of a nomination |

### `rounds_recursion_filter`

One row per round. Rows are never deleted.

| Column | Meaning |
|---|---|
| `question_id`, `round_no` | unique together; round 0 is nomination |
| `kind` text: `nomination` / `elimination` | |
| `pick_min`, `pick_max` | copied from the question, can be changed before the gate opens |
| `drop_count` int, nullable | set by the chair while open or before settling |
| `gate_open`, `opened_at`, `closed_at`, `settled_at` | |
| `outcome` jsonb | frozen record of the settled round: the counts, who dropped, the tied group and the chair's pick, and the winner if any |

### `votes_recursion_filter`

The common vote columns, plus `round_no int`, `option_id` (nullable) and `abstain bool`, with `check ((option_id is not null) <> abstain)`. There is one row
per pick, like `votes_highest_x`. The uniqueness rule becomes
`(question_id, round_no, voter_key, option_id) where valid`, so each round is a
fresh vote and earlier rounds stay on record.

## The rules in the database

| Function | What it does |
|---|---|
| `cast_recursion_filter(ballot, pin, question, options uuid[], fingerprint)` | The current round must be open. Each option must be valid for this round: `pool` in round 0, `in` after that. The number of picks must be between `pick_min` and `pick_max`. Changing a vote follows the ballot's `allow_vote_change`, as today. |
| `tally_recursion_filter(question, round)` | Counts per candidate, number of voters, the leader and whether they have a majority, and which candidates the current `drop_count` would drop. If the cut falls inside a tie, it returns the tied group and how many of them must go. |
| `set_round_drop_count(question, n)` | Chair only. Allowed while the round is open or closed but not settled. `n` can be 0 but has to leave at least one person in. |
| `withdraw_candidate(question, option)` | Chair only, with the gate closed. Sets `withdrawn` and `dropped_round`. Has to leave at least one person in. |
| `end_recursion(question, winner uuid default null)` | Chair only, with the gate closed. Ends the vote early: either the chosen candidate wins, or the question ends with no winner. Recorded in the round's `outcome`. |
| `settle_round(question, tie_drop uuid[] default null, shortlist uuid[] default null)` | Chair only, with the gate closed. It applies the cut. If the cut needs a tie broken and `tie_drop` is missing, it refuses and names the tied group. It writes `outcome`, then either declares the winner or creates the next round row. Round 0 settles by threshold instead of drop count. |
| `add_candidate(question, option or pool entry)` | Chair only. Moves a `pool` row to `in`, or copies an entry that was added to the pool later. It sets `joined_round` to the next round. |
| `set_gate` branch | Opens or closes the **current round**, and mirrors that onto the question. A round can't open until the one before it is settled. |

### Shared functions that need a new branch

`ballot_questions` view, `set_gate`, `close_all_gates`, `question_results`,
`voter_state`, `app.voters_on` (counts the **current round** only, so the
"12 of 40 have voted" counter starts fresh each round), `expected_on`,
`advance_ballot`, `clear_ballot_votes`, `reset_token`,
`app_questions_voted`, `app_settled_results`, `app_guard_anonymity`,
`copy_pool_into_question`, the purge and retention job,
`sweep_orphaned_votes`, deleting a PIN together with its votes, RLS on the
four new tables, and the realtime publication for the rounds and votes tables.

### `advance_ballot` (the chair's "next" button)

When the open question is a recursion filter that isn't decided yet, "next"
moves through its rounds instead of to the next question:

- round open → close it
- round closed but not settled → stop and tell the chair what's needed: the drop count, a tie to break
- settled with no winner yet → open the next round
- decided → move to the next question, as today

## Screens

| Page | Changes |
|---|---|
| `Questions.tsx` (create a question) | Pool picker (required), nominations per voter, nomination threshold, default picks per round, stop-on-majority toggle |
| `Live.tsx` (the chair) | A round panel showing the round number and its gate, a live count, the drop-count input, Settle, a tie-break picker when needed, Add from pool, and the shortlist with who dropped in which round |
| `Vote.tsx` | Shows "Round 2 of the vote for Chair". The voter ticks up to `pick_max` from the current list. After voting, a waiting screen until the next round opens. |
| `Results.tsx` | A round-by-round table. Public only after each round is settled, following the existing "results once the gate closes" rule. |
| `lib/types.ts`, `lib/api.ts`, `lib/rules.ts` | The new type, its calls, and client-side pick limits that match the database |

## Build order

1. **Schema migration**: the tables, the registry row, the view branch, RLS, and realtime.
2. **Round engine**: tally, settle, the gates, `add_candidate`, the drop count.
3. **Casting and `voter_state`**, plus the branches in the shared functions.
4. **SQL walkthrough on a Supabase dev branch**: the worked example above,
   including the tie, a mid-race add, an early majority, a re-vote and a deleted PIN.
5. **Frontend**: create the question, run it from the chair, vote, see the results.
6. **Browser test end to end**, then apply to production.

## Decisions

1. **Adding someone while a round is open.** They join **the next round**,
   because people who already voted never saw them. `add_candidate` sets
   `joined_round = current_round + 1` when the gate is open, and the chair is
   told so. With the gate closed, they join the round about to open.
2. **Abstaining.** Same as the other types: an `allow_abstain` setting on the
   question, off by default, with an `abstain_label`. An abstention is one
   vote row with `abstain = true` and no option, as in
   `votes_highest_outright`. It counts toward "has voted" but not toward any
   candidate.
3. **Majority when voters pick several people.** A candidate has a majority
   when **more than half of the voters in that round** backed them. Voters who
   abstained are not counted in that half.
4. **Withdrawals.** The chair can withdraw a candidate with the gate closed.
   This sets a new status, `withdrawn`, and records `dropped_round`. It is kept
   apart from `dropped` so the results show who declined and who was voted out.
   `withdraw_candidate(question, option)` is chair only.
5. **Skipping nomination.** Allowed. With round 0's gate never opened, the chair
   can call `settle_round` with a hand-picked shortlist
   (`p_shortlist uuid[]`). Round 0's `outcome` records that the shortlist was
   set by the chair, not by votes. Round 1 then runs as normal.
6. **Too few nominations.** If nobody reaches the threshold, `settle_round`
   refuses, and the chair lowers `nominate_threshold`, adds people from the
   pool, or sets the shortlist by hand (decision 5). If exactly one person
   qualifies, the chair either confirms them as winner (`end_recursion`) or
   adds others before round 1.
