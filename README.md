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
and nothing else — there is no directory to browse. A PIN is unique *per ballot*
rather than globally, so `find_ballots_for_pin` resolves it: one match goes
straight through to the lobby, several ask which, none says so. The PIN is
handed to the ballot page in memory, never through the URL or storage — a reload
asks for it again, which is the right way round.

That lookup widens the guessing surface, since one guess now probes every
published ballot at once. The counterweight is the same lock-out the ballot
itself uses — twelve failed lookups per browser per fifteen minutes, failures
only — and the answer carries only a ballot's title and whose it is.

## How a meeting runs

```
   PIN ──▶ every open question, answerable where it stands ──▶ exit
            ▲                                              │
            └───────────────── reload ─────────────────────┘
```

Every question the chair has opened is answered in place, on one page. There
used to be a list you tapped into and backed out of, which cost two taps and a
page change per answer and hid from a voter how much was in front of them —
expensive in a room where the chair is waiting on the slowest phone.

In **gated** mode that page holds the questions whose gates are open, so what is
in a voter's hand changes when the meeting moves on. In **open** mode it holds
the whole ballot and voters work at their own pace. A large **Exit voting**
button sits at the end — the last thing a voter wants, and the one thing they
should not hit on the way past a question.

The gate is re-checked in the database at the moment of the click, not when the
page was drawn, so a stale lobby cannot slip a vote through a gate that has
since closed.

Replacing a vote never deletes anything. The standing rows go `valid = false`
and the new ones are written beside them; the tally ignores the superseded ones.
The one exception is deleting a PIN, which takes its votes with it — a vote
whose PIN no longer exists cannot be traced to anything, so keeping it is not
keeping a record, it is keeping a number. `reset_token` is the way to void a
PIN's votes and keep the trail.

**Three ways to take a PIN out of circulation**, and they are not the same
thing. *Disable* stops it voting again and leaves what it already cast standing
and counted — so it still counts as one of the voters a question is waiting on,
or disabling someone would let their vote stand for the room. *Reset* voids its
votes and keeps the rows, so the log still reads. *Delete* removes the PIN and
takes its votes with it.

**One button runs the meeting.** `advance_ballot` closes what is open, opens
what is next, and closes the ballot when there is no next — atomically, so there
is never a moment with two gates open or none. With **all PINs must vote** on,
it refuses to step past a question while an active PIN has not answered it, and
says how many are outstanding; the Live tab shows the same count per question.

## What is public and what is not

- **Private to their owner** — organizations. Nothing public reads that table:
  a voter gets the organization's name from `find_ballots_for_pin`, which is
  security definer and does not go through the policy.
- **Public** — published ballots, their questions and options,
  and the votes on any question that has **finished**, if the ballot publishes
  results at all.
- **The organizer's alone until then** — the count on a question still taking
  votes. A running tally changes how people vote. `app.question_public` is the
  whole rule: a question is public when the ballot publishes results *and* that
  question can no longer be voted on — its gate is closed, or the ballot is. So
  a chair can close the first motion and announce it while the rest are still to
  come. The same function guards the read policy on all three vote tables —
  which is what Realtime checks per subscriber, so nobody can watch the votes
  arrive either — and `ballot_results`, which reports how many questions it is
  withholding rather than handing back a short list that reads as the whole
  ballot. Hiding the button would have left the URL serving it.
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

## An organization's mark

An organizer can set a logo from **Settings** on their organization card. It
shows on the ballot a voter opens, on the public results, in the middle of every
QR on a printed sheet, and again on the right of each slip at the same visible
size as the code — the code's box includes its quiet zone, so the mark is scaled
by that same fraction or the two look different sizes in the same box.

The image lives in a storage bucket; `organization_images` records which object
belongs to which organization and is owner-only. The bucket is public to *read* —
a voter has to see the mark without an account, and a signed URL per slip on a
printed sheet cannot work — and writable only into `<org id>/…`, which the
storage policies check with `app.owns_organization`. The path reaches a voter
through `voter_state`, `ballot_results`, `find_ballots_for_pin` and
`ballot_logo`, so nothing had to make a directory of organizations readable
again.

The QR carries the mark over about 5% of its area, well inside what error
correction level M recovers. Printed sheets inline it as a data URI, because
`window.print()` does not wait for a network image and a sheet with a hole in
every code is worse than one with no mark. A test decodes every code on a
printed sheet and checks each one still reads back the exact voting URL.

## Setting up a ballot

Options can be pasted rather than typed one at a time: the box takes a name, a
column, or a row, so a list straight out of a spreadsheet works as it is.
Commas and newlines both separate, quoted fields are respected (`"Smith, J"` is
one candidate), repeats are dropped case-insensitively against what the question
already has — the same way the unique index behind it matches — and the button
says how many will actually be added.

## Ballots do not live forever

Every ballot is deleted **30 days** after it is made, by a `pg_cron` job that
runs daily and leaves a receipt in `purge_log`. The window, and the quotas
below, are each one function in the `app` schema rather than a literal repeated
through triggers and defaults:

| | |
| --- | --- |
| `app.ballot_retention()` | 30 days |
| `app.max_organizations_per_user()` | 5 |
| `app.max_ballots_per_organization()` | 20 |

Nothing vanishes quietly: the ballot's own page carries the countdown and a
**Renew** button that pushes the full window out again. An owner may bring an
expiry forward but never past the cap, which is why `expires_at` is readable but
not writable from a client. A ballot stops taking votes the moment it expires
rather than whenever the purge next runs.

**PINs print as slips.** The PINs tab renders one cut-out per active PIN — a QR
of the voting link down the left, the ballot title, the code and the link in the
middle, and the organization's mark on the right. The printed link is
`/vote/<org slug>/<ballot slug>`, because a slip is read by a person and typed
by one; `resolve_ballot` turns that pair back into the ballot, since
organizations are owner-only and a voter cannot do that join. Both forms of the
link work — revealed by `@media print`
rather than by opening a second document, so there is nothing to keep in step
and no popup for a browser to block. Eight to a page, two across and four down.
Each group of eight is its own page box, `100vh` tall with four rows of
`minmax(0, 1fr)` — so a row is a quarter of the page by construction, whatever
the paper and whatever the print dialog's scale. A test counts the pages of real
PDFs across nine combinations of paper, margin and scale.

`public.app_limits()` exposes the two quotas so a form can say "4 of 5
organizations" without a constant in the client drifting from the database that
enforces it.

## Watching a vote come in

`#/live/<ballot>` is the chair's monitor: every question at once, each stated in
its own terms — carried or defeated, who leads, who is inside the cut — sized to
be read from the back of a room. Signed in only, because while a ballot is
running its count is nobody else's business.

It does not assemble the tally from the change events. A write to a vote table
is only a nudge to re-ask `ballot_results`, which stays the one place a count is
derived, so a dropped, replayed or out-of-order event costs nothing but a
redundant refresh. A fifteen-second poll runs underneath regardless — sockets
die quietly on venue wifi, and a number left on a projector has to be right when
nobody is watching it closely enough to notice it has gone stale. The dot in the
header says which of the two is currently carrying it.

## Layout

```
frontend/            the static client
  src/
    lib/               supabase client, the API surface, routing, the rules, the live feed
    pages/             Home, Vote, Results, Live, SignIn, Admin, Manage, Questions, Tokens
    components/ui.tsx  the small shared pieces
    app.css            one stylesheet
  public/              copied into dist/ verbatim: the manifest and its icons
  icons/               the icon artwork as SVG, and the script that renders it
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
