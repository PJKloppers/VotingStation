# VotingStation

**[vote.paulkloppers.co.za](https://vote.paulkloppers.co.za/)**

Token voting for organizations. An organizer signs in, sets up a ballot, hands
each voter a six-digit PIN, and opens one question at a time from the chair.
The count publishes itself.

Voters never have accounts. They hold a slip of paper with a code on it, which
is the only thing standing between the meeting and the vote — so the slip, and
what the database will do on the strength of it, is most of what this project
is about.

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
(`enabled` is pinned true by a check constraint: it once let a question be kept
off a ballot, nothing used it, and with no control left a question switched off
would have vanished from the chair's list with no way back.)

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

A voter arrives holding a printed slip, so the front page is a camera pointed at
it. The code carries the ballot's own link; scanning it lands them on that
ballot, where their PIN opens their vote.

That ordering is the point. Nothing searches for a PIN any more, so a code only
has to be unique on the ballot it belongs to — which it always was,
`unique (ballot_id, pin)` — and far more than a million codes can exist across
the system. It also closes what the old front page cost: a global lookup meant
one guess probed every published ballot at once.

A scanned code is read by `readDestination`, which takes all three forms — the
pair of slugs printed today, the uuid on slips already handed out, and a single
organization slug, which lands on that organization's published ballots. A URL
has to carry one of the app's own routes to count at all: without that check the
deploy's own `/VotingStation/` prefix read as an organization by that name, and
so did any one-segment URL from anywhere.

The camera needs a secure context, so plain http on a venue's LAN refuses it —
and a locked-down phone or a laptop without a camera will too. The slip prints
the link in words under the code for exactly that, and the page takes what is
printed there. The scanner and its decoder are loaded only when the button is
pressed: `splitting` is on in the build, so a voter who types a link or follows
one straight to a ballot never downloads either.

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

- **Private to their owner** — organizations. Nothing public reads that table.
  A voter gets what they need through security-definer functions that do not go
  through the policy: `resolve_ballot` turns a printed `<org>/<ballot>` pair
  into a ballot, `org_ballots` answers with one organization's *published*
  ballots by slug, and `ballot_logo` gives the mark's path. There is no way to
  list organizations, and no way to ask which ballots a PIN belongs to — that
  lookup was removed, and with it the guess that probed every published ballot
  at once.
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

A vote is filed against the PIN that cast it, and `voter_key` carries no grant
for any role a browser can hold — so nothing reads it through the API, not the
public and not the organizer who owns the ballot. A PIN is six digits on a slip
and nothing here records who was handed which, so what a vote is attributed to
is a piece of paper rather than a person.

Anonymous ballots — a salted SHA-256 pseudonym of the PIN instead — are no
longer offered. An investigation of what that was actually worth found it never
protected a voter from the organizer, who holds every PIN in plain text; the
plainest break was a timestamp, since `ballot_tokens.last_vote_at` was written
in the same transaction as the vote's `created_at` and so matched it to the
microsecond, which one join turned into a name for every row. That is closed,
and ballots already run under the pseudonym keep theirs — the hashing stays
because their keys are computable no other way.

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
through `voter_state`, `ballot_results`, `org_ballots` and `ballot_logo`, so
nothing had to make a directory of organizations readable again.

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

### Option pools

The same twelve names go to a meeting three times in an evening — elect a
chair, elect a secretary, elect the committee — and retyping them is where
mistakes come from. An **option pool** is that list, kept once on the
organization it describes, and copied onto any question that needs it from
`/pools` or from the question editor.

It is a **copy, not a link**, and that is the point rather than a shortcut:
once the entries are options they belong to the question, so editing the pool
afterwards cannot reach back into a ballot that may already have votes on it.
The copy appends, so two names typed by hand before it survive, and it answers
with how many it added. A yes/no question is refused — it has no options to
copy into.

Pools live in `option_pools` and `option_pool_entries`, owner-scoped through
`app.owns_organization` and `app.owns_pool`. The copy itself is
`copy_pool_into_question`, which checks that *both* ends belong to the caller
before it writes. The limit is three, counted per account rather than per
organization, so spreading pools around does not buy more of them.

## The organizer's account

Signing in is by password, by **Google**, or by **passkey**. OAuth comes back
through PKCE rather than the implicit flow, and that is not a preference: the
implicit flow returns the session in the URL *fragment*, and the fragment is
this app's router — the return would arrive as a route reading
`access_token=…`. PKCE puts a `?code=` in the query string, which the router
never looks at, so the route survives the round trip by construction rather
than by winning a race.

A **passkey** is added from the account page and signs in with no address
typed at all, because a passkey identifies the account as well as proving it.
Adding one does not take the password away. Each is named and says when it was
last used, since an account with three passkeys and no idea which is which is
worse than an account with none. They are bound to one domain by their relying
party, so a passkey made on the app's own address is not offered on localhost
or under the `/VotingStation/` prefix — WebAuthn doing its job.

**Forgot your password** sends a reset link, and answers the same sentence
whether or not that address has an account: telling a stranger which addresses
are registered is the one thing that form could leak. Which flow a returning
code belongs to rides in `?flow=recovery`, because PKCE appends its `?code=` to
whatever redirect URL it was given and a `#/reset-password` on the end would
put the code inside the fragment where the library never looks.

**Closing an account** takes everything with it. `delete_my_account()` takes no
arguments, and that is the whole of its security: the only row it can delete is
`auth.uid()`'s — there is no target to forge. The rest is cascade —
organizations from the owner, ballots from the organization, and from a ballot
its questions, PINs and votes, plus the mark's row and the object in the
bucket. The page counts what is about to go and says it ("2 organizations and
5 ballots", not "your data") and wants the address typed.

An organization can be deleted the same way from its settings, with the same
counting and the same typed confirmation.

### The letters

The auth emails live in `supabase/templates/` — confirm signup, reset
password, magic link, invite, email change, and the reauthentication code — in
the app's own palette, and installed by `scripts/push-email-templates.ts`.

That script uses the Management API and **not** `supabase config push`, which
is the whole reason it exists: `config push` sends the entire auth config, so
anything `config.toml` leaves unsaid goes as its default and would overwrite
the providers, the redirect URLs and the site URL the project actually has. A
PATCH names only the mailer fields. It prints what differs and stops unless
given `--apply`, then reads the config back and compares each template against
the file on disk, because a 200 means the request was accepted and not that the
project holds what the repository holds.

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
| `app.max_option_pools_per_user()` | 3 |

Nothing vanishes quietly: the ballot's own page carries the countdown and a
**Renew** button that pushes the full window out again. An owner may bring an
expiry forward but never past the cap, which is why `expires_at` is readable but
not writable from a client. A ballot stops taking votes the moment it expires
rather than whenever the purge next runs.

**PINs print as slips.** The PINs tab renders one cut-out per active PIN — a QR
of the voting link down the left, the ballot title, the code and the link in the
middle, the organization's mark, and the PIN's own barcode standing up the right
edge. The printed link is
`/vote/<org slug>/<ballot slug>`, because a slip is read by a person and typed
by one; `resolve_ballot` turns that pair back into the ballot, since
organizations are owner-only and a voter cannot do that join. Both forms of the
link work — revealed by `@media print`
rather than by opening a second document, so there is nothing to keep in step
and no popup for a browser to block. Sixteen to a page, two across and
eight down. Each group of sixteen is its own page box, `100vh` tall with eight
rows of `minmax(0, 1fr)` — so a row is an eighth of the page by construction,
whatever the paper and whatever the print dialog's scale. A test counts the
pages of real PDFs across nine combinations of paper, margin and scale.

**The code can carry the PIN**, and is off unless an organizer turns it on for
that print. With it on, each slip's code is its own link — `?pin=…` — and
scanning it opens the ballot already signed in; the PIN is used once and taken
straight back out of the address bar, so it does not sit in the history of a
shared phone. It is off by default because it makes the printed code the
credential: anyone who photographs the slip can vote with it.

**The PIN also prints as a barcode**, always, whichever way that setting is
left — Code 128 in subset C, which reads digits in pairs, so six of them are
three data symbols rather than six. It stands on end because a slip is far
wider than it is tall and a barcode's need is the opposite way round: its
length divided by its 88 modules is the width of the narrowest bar, and that is
what decides whether it reads. Lying across the slip that was 0.204mm; standing
up the slip's height it is 0.324mm, comfortably clear of the ~0.19mm below
which scanners start to miss. The encoder is ours, so the tests decode what it
draws with ZXing — somebody else's — rather than running our own encoder
backwards and agreeing with themselves.

**A slip can be scanned back in.** *Scan to delete* on the PINs tab points the
camera at a slip and takes that PIN off the roll, votes and all: the person at
the desk has the paper in their hand and no wish to find six digits in a table
of two thousand. It reads either code — the barcode always carries the PIN, the
QR only when the sheet was printed that way — and each scan stops and asks,
with the vote count in the question, because it cannot be undone. The voter's
PIN screen offers the same reader, so nobody has to type six digits at all.

Both decoders try the frame and its quarter turn: the barcode is printed
standing up, ZXing's luminance source reports no rotation support so it will
not try the other way round on its own, and somebody holding a slip up to a
camera holds it whichever way it came off the pile.

`public.app_limits()` exposes all three so a form can say "4 of 5
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
frontend/              the static client
  src/
    lib/
      supabase.ts        the client, and the two flags that matter: PKCE, passkeys
      api.ts             every call the client can make, in one place
      auth.ts            sessions, Google, passkeys, the reset flow
      router.ts          hash routing, and the one path route
      rules.ts           the selection rules, shared with the tests
      qr.ts barcode.ts   the two encoders, written here and decoded in the tests
      codes.ts camera.ts reading either code out of a camera frame
      scan.ts resolve.ts what a scanned code points at, and how a link resolves
      watch.ts live.ts   the voter's auto-refresh, and the chair's monitor feed
      options.ts slug.ts the pasted-list parser, and slugs
    pages/             Home Vote Results Live SignIn Admin Manage Questions
                       Tokens Organization Pools Account ResetPassword
                       PrivacyAndTerms
    components/        Header Footer GithubPill ui, and the three scanners:
                       Scanner (a voter arriving), PinScanner (a voter's own
                       PIN), PinDeleteScanner (the desk taking one back)
    app.css            one stylesheet, print sheet included
  public/              copied into dist/ verbatim: the manifest and its icons
  icons/               the icon artwork as SVG, and the script that renders it
  tests/
    unit/              the selection rules, the router, the scanner's parsing
    integration/       the whole system against the real database
    e2e/               the built page driven in Brave, camera and printer included
  build.ts             bun build, HTML entry point in and a static directory out
scripts/               push-email-templates.ts, the Management-API installer
supabase/
  migrations/          the schema, in order
  templates/           the auth emails
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
The camera tests need **ffmpeg**, which is what builds the fake capture device —
a still of a real code, encoded by this project's own encoder, played into the
browser as a video file. They skip themselves where there is none, and there is
a test whose only job is to fail if that ever happens silently.

Three things the suites deliberately do not do. They never send an auth email:
the project is on Supabase's own SMTP, which rate-limits to a handful an hour,
and a suite that burned them would take the real reset flow down with it. They
never press the last button on *delete this account*, because that account is
the one they sign in as. And they cannot run the passkey ceremony, which is
bound to the deployed domain by its relying party.

## Deploy

The client is static. Pushing a change under `frontend/` to `main` builds it and
publishes it to GitHub Pages — see `.github/workflows/pages.yml`. Enable Pages
with **Settings → Pages → Source: GitHub Actions** once.

Routing is on the hash (`#/vote/<id>`), which needs no rewrite rule, and the
build emits relative asset paths, so the same output works at a domain root or
under a `/VotingStation/` prefix.

One page is the exception. `/privacy-and-terms-of-service` answers to a real
path as well, because that is the URL an OAuth reviewer has to be given and a
fragment is a poor thing to hand one. Pages serves `404.html` for a path it has
no file for, and the build makes that a copy of the app, so the request arrives
with the route still in `location.pathname`; only the last segment is matched,
since the deploy prefix is not knowable from inside the client.

That has a consequence worth knowing, because it bit once: reaching that page
and then clicking into the app leaves the address bar reading
`/privacy-and-terms-of-service#/admin` — the fragment moves, the path does not.
Anything building an absolute URL from `location.pathname` would carry the
document's path with it, which is why every one of them goes through
`appBase()` instead.

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
