# VotingStation

Token voting for organizations. An organizer signs in, sets up a ballot, hands
each voter a six-digit PIN, and opens one question at a time from the chair.
The count publishes itself.

The client is a static React page — no server of ours anywhere. Every rule that
matters lives in Postgres, because a page anyone can edit cannot be trusted with
a PIN, a gate, or a selection rule.

```
   organizer (auth.users)  1──*  organizations  1──*  ballots
                                                        │
                          ┌─────────────────────────────┼──────────────┐
                          │                             │              │
                    ballot_tokens              questions_<type>   votes_<type>
                    (PINs, private)            (+ options_<type>) (public)
```

## The shape of a ballot

Every question type owns its own tables. A yes/no motion, a first-past-the-post
election and an X-of-N election record different things, so they get different
columns rather than a shared bag of nullable ones.

| Type | Question table | Options | Votes | The rule |
| --- | --- | --- | --- | --- |
| `yes_no` | `questions_yes_no` | fixed | `votes_yes_no` | carried when the Yes share clears the question's fraction of the **decisive** (non-abstaining) votes |
| `highest_outright` | `questions_highest_outright` | `options_highest_outright` | `votes_highest_outright` | the single option with the most votes; optionally required to clear half of the votes cast |
| `highest_x` | `questions_highest_x` | `options_highest_x` | `votes_highest_x` | the top `winner_count` options, with a tie at the cut-off reported rather than broken |

Every question table repeats the same block of common columns — `ballot_id`,
`prompt`, `description`, `sort_order`, `enabled`, `gate_open`, `opened_at`,
`closed_at` — and the `ballot_questions` view unions them into one ordered list.

**Adding a type** is three things and nothing else:

1. a `questions_<type>` table, an `options_<type>` table if it needs one, and a
   `votes_<type>` table whose columns match what that type records;
2. a row in `question_types`, and a branch in the `ballot_questions` view;
3. a `cast_<type>` function, a `tally_<type>` function, a branch in
   `question_results`, and a branch in `voter_state`.

Nothing that already works has to change.

### The yes/no threshold is a fraction, not a decimal

`pass_num / pass_den` with a `threshold_strict` flag, so two-thirds is exactly
two thirds. `1/2` strict is a simple majority — a tie fails. `2/3` loose is *at
least* two thirds. Storing `0.667` would have quietly failed a 2-of-3 vote.

## Arriving

A voter arrives holding a PIN and nothing else, so the front page asks for that
and nothing else. A PIN is unique *per ballot* rather than globally, so
`find_ballots_for_pin` resolves it: one match goes straight through to the
lobby, several ask which, none says so. The PIN is handed to the ballot page in
memory, never through the URL or storage — a reload asks for it again, which is
the right way round.

That lookup widens the guessing surface, since one guess now probes every
published ballot at once. The counterweight is the same lock-out the ballot
itself uses — twelve failed lookups per browser per fifteen minutes, failures
only — and the answer carries nothing a reader could not already get from the
public directory below it: a ballot's title and whose it is.

## How a meeting runs

```
        ┌──────────────────────── the voter's loop ────────────────────────┐
        │                                                                  │
   PIN ─┴─▶  LOBBY  ──(gate open)──▶  QUESTION  ──(submit)──▶  DONE  ──────┘
             ▲    │
             └────┘  reload
```

In **gated** mode the lobby lists only the questions whose gate the chair has
opened, so the page in a voter's hand changes when the meeting moves on. In
**open** mode every enabled question is listed at once and voters work at their
own pace.

The gate is re-checked in the database at the moment of the click, not when the
page was drawn, so a stale lobby cannot slip a vote through a gate that has
since closed.

Replacing a vote never deletes anything. The standing rows go `valid = false`
and the new ones are written beside them; the tally ignores the superseded ones.

## What is public and what is not

- **Public** — organizations, published ballots, their questions and options,
  and the vote rows of any ballot that publishes its results. The tally is the
  point of the system.
- **Never public** — `ballot_tokens` (the PINs), `pin_attempts`, and
  `ballots.vote_salt`, which is excluded from every grant, so no client can
  read it even by accident. A `select('*')` on `ballots` is refused; the client
  names its columns.
- **Never writable from a browser** — the vote tables carry no `INSERT`,
  `UPDATE` or `DELETE` grant for anyone. Votes arrive only through the `cast_*`
  functions, which check the PIN, the gate, and the question's own rules.

With anonymous ballots on (the default), each vote carries a salted SHA-256
pseudonym of the PIN rather than the PIN itself. The salt lives in a column
nothing can read, and swapping a ballot between anonymous and named is refused
once a vote exists — it would strand every key already recorded.

Failed PIN attempts are counted per browser, twelve in fifteen minutes. Only
*failures* count, so a voter reloading the lobby for an hour is never shut out
of their own ballot. The voter-facing functions **return** their errors rather
than raising them, because a raise would roll back the counter along with
everything else.

## Setting up a ballot

Options can be pasted rather than typed one at a time: the box takes a name, a
column, or a row, so a list straight out of a spreadsheet works as it is.
Commas and newlines both separate, quoted fields are respected (`"Smith, J"` is
one candidate), repeats are dropped case-insensitively against what the question
already has — the same way the unique index behind it matches — and the button
says how many will actually be added.

## Layout

```
frontend/            the static client
  src/
    lib/               supabase client, the API surface, routing, the rules
    pages/             Home, Vote, Results, SignIn, Admin, Manage, Questions, Tokens
    components/ui.tsx  the small shared pieces
    app.css            one stylesheet
  tests/
    unit/              the selection rules and the router, no network
    integration/       the whole system against the real database
    e2e/               the built page driven in Brave
  build.ts             bun build, HTML entry point in and a static directory out
supabase/migrations/   the schema, in order
.github/workflows/     build and publish to Pages on a change under frontend/
```

## Build and test

```bash
cd frontend
bun install
bun run build          # -> dist/, ready for any static host
bun run serve          # serves dist/ on :4173
bun run typecheck

bun test tests/unit          # fast, offline
bun run test:integration     # signs in, builds a throwaway ballot, tears it down
bun run test:e2e             # needs `bun run build` first; HEADED=1 to watch
```

The integration and browser suites need an organizer account. Set `TEST_EMAIL`
and `TEST_PASSWORD`, or point `TEST_CREDENTIALS_FILE` at a two-line file holding
the address and then the password. Nothing of the sort is committed.

The browser suite drives **Brave**; set `BRAVE_PATH` if it is somewhere unusual.

## Deploy

The client is static. Pushing a change under `frontend/` to `main` builds it and
publishes it to GitHub Pages — see `.github/workflows/pages.yml`. Enable Pages
with **Settings → Pages → Source: GitHub Actions** once.

Routing is on the hash (`#/vote/<id>`), which needs no rewrite rule, and the
build emits relative asset paths, so the same output works at a domain root or
under a `/VotingStation/` prefix.

The Supabase URL and publishable key are compiled in. Both are public values —
the key only ever grants the `anon` role, which the grants and policies above
keep to the voter surface. To point a fork at its own project, set the
repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.

Apply the schema to a fresh project with the Supabase CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

One thing the migrations cannot set: turn on **leaked password protection**
under Authentication → Policies, so organizer accounts cannot use a password
that is already in a breach corpus.

## Where this came from

The logic is a port of a Google Sheets voting system built for a single
organization's live meetings — PINs on a Tokens sheet, one sheet per topic, a
gate the chair opened from a phone at the front of the room. This version keeps
that shape and its lessons (the gate re-check, superseded rather than deleted
ballots, counting only failed PIN attempts, a tally derived and never
incremented) and adds what a spreadsheet could not: many organizations, a real
authorization boundary, and one table per question type.
