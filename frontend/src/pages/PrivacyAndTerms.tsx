/**
 * What this system stores, who can read it, and on what terms.
 *
 * Every claim below is a claim about this code -- the migrations under
 * supabase/ and the client around this file -- rather than about voting
 * software in general. Where the honest answer is awkward it is section 5,
 * which exists so that nobody has to find those things out from somebody
 * else. If a rule here stops being true of the schema, this page is wrong and
 * the fix is here as much as there.
 *
 * It is reachable two ways: `/privacy-and-terms-of-service` as a real path,
 * which is what an OAuth reviewer can be given, and `#/privacy-and-terms-of-
 * service` like every other page. See lib/router.ts for how the path one
 * survives GitHub Pages having no rewrite rule.
 */
import type { ReactNode } from 'react';
import '../privacy.css';

const REPO = 'https://github.com/PJKloppers/VotingStation';

/**
 * The sections, in the order they appear.
 *
 * One list, read by both the contents and the headings, so a renamed section
 * cannot be renamed in only one of the two places. The numbering is a CSS
 * counter over the same markup order, so it cannot drift either.
 */
const SECTIONS = {
  who: 'Who this covers',
  voter: 'What a voter gives, and what is never asked',
  recorded: 'How a vote is recorded',
  published: 'What is published, and what is not',
  limits: 'Known limits — read this one',
  kept: 'How long things are kept',
  lives: 'Where the data lives, and who else touches it',
  organizers: 'Organizer accounts',
  removal: 'Asking for something to be removed',
  terms: 'Terms of service',
  contact: 'Contact, and changes to this page',
} as const;

type SectionId = keyof typeof SECTIONS;

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  // tabIndex so that following one of the links below moves the keyboard as
  // well as the scroll position; nothing in app.css outlines a section, so it
  // costs no ring.
  return (
    <section className="doc-section" id={id} tabIndex={-1}>
      <h2>{SECTIONS[id]}</h2>
      {children}
    </section>
  );
}

/**
 * A link from one part of this page to another.
 *
 * It cannot be a plain `#limits`: the app routes on the fragment, so setting
 * one would be read as a route and answered with "there is no page at
 * /limits". The href is kept for the context menu and the status bar, and the
 * click is handled here instead.
 */
function Anchor({ to, children }: { to: SectionId; children: ReactNode }) {
  return (
    <a
      href={`#${to}`}
      onClick={(event) => {
        event.preventDefault();
        const target = document.getElementById(to);
        target?.scrollIntoView();
        target?.focus({ preventScroll: true });
      }}
    >
      {children}
    </a>
  );
}

/** Something a human still has to decide. Never guessed at in the prose. */
function Todo({ children }: { children: ReactNode }) {
  return <p className="doc-todo">To be filled in: {children}</p>;
}

export function PrivacyAndTerms() {
  return (
    <main className="doc">
      <header className="doc-head">
        <p className="eyebrow">VotingStation</p>
        <h1>Privacy and terms of service</h1>
        <p className="lede">
          VotingStation runs token votes for organizations. This page says what it stores,
          who can read it, and how long it keeps it. It describes this code and this
          deployment rather than an idea of what a voting app might do — so where the
          answer is awkward, the awkward answer is the one written down.
        </p>
        <p className="doc-meta">
          Last reviewed 13 September 2026. Applies to the deployment published at{' '}
          <code>pjkloppers.github.io/VotingStation</code> and the one database behind it.
        </p>
      </header>

      <nav className="doc-toc" aria-label="Contents">
        <h2>Contents</h2>
        <ol>
          {Object.entries(SECTIONS).map(([id, title]) => (
            <li key={id}><Anchor to={id as SectionId}>{title}</Anchor></li>
          ))}
        </ol>
      </nav>

      <Section id="who">
        <p>
          Two kinds of people use VotingStation, and they are treated very differently.
        </p>
        <p>
          <strong>Voters have no account.</strong> A voter holds a six-digit PIN that is
          valid on one ballot and nowhere else. Nothing asks a voter for a name, an email
          address or anything else about them, and there is no field against a PIN in which
          an organizer could record one — the column that once held a label was removed,
          because nothing wrote to it and nothing read it.
        </p>
        <p>
          <strong>Organizers have an account.</strong> They sign in with an email address
          and a password. Signing in with a Google account is being added; when it is, the
          email address on that account is what Google returns and what the account is
          keyed on, and nothing further is asked for.
        </p>
        <p>
          “The operator” below means whoever runs this particular deployment: the GitHub
          Pages site named above and the single database it talks to. The source is public,
          and anyone may run their own copy — a fork is a different service with a
          different operator, and this page says nothing about it.
        </p>
        <Todo>
          the legal identity of the operator, if one is needed. There is no company behind
          this deployment, and none is invented here to fill the gap.
        </Todo>
      </Section>

      <Section id="voter">
        <p>Three things reach the database when someone votes.</p>
        <ul>
          <li>
            <strong>The PIN.</strong> Typed in, or carried by the code on a printed slip if
            the organizer chose to print it that way. It is checked inside the database;
            the page in your browser never gets to decide whether a PIN is good.
          </li>
          <li>
            <strong>The answers.</strong> Which option, or yes / no / abstain, on each
            question — and nothing else about the moment of voting beyond when it happened.
          </li>
          <li>
            <strong>A random id from your browser.</strong> The first time a browser is
            used to try a PIN it generates a random UUID and keeps it in local storage
            under <code>votingstation.fp</code>. It goes with every PIN attempt so that the
            lock-out counts one device’s wrong guesses instead of the whole room’s: twelve
            failures within fifteen minutes locks that browser out of that ballot for
            fifteen minutes. Only failures count, so sitting on a waiting screen never
            locks anyone out of their own ballot. It is not a fingerprint in the tracking
            sense — it is a random number, it is not derived from anything about your
            device, it identifies you nowhere else, and clearing site data throws it away.
          </li>
        </ul>
        <p>
          Not asked for and nowhere in the schema: a voter’s name, email address, phone
          number, location or device details. Nothing in this app records an IP address
          either, though the services underneath it do — see{' '}
          <Anchor to="lives">where the data lives</Anchor>.
        </p>
        <p>
          There is no analytics, no advertising, no error reporting service and no
          third-party script of any kind. The whole page is served from one origin, with no
          external fonts and no tag manager. This app sets no cookies; what it keeps in a
          browser is the two entries listed in <Anchor to="kept">how long things are kept</Anchor>.
        </p>
        <p>
          A PIN also carries a weight — one vote unless the organizer changes it — and a
          count of how many questions it has answered.
        </p>
      </Section>

      <Section id="recorded">
        <p>
          <strong>Every ballot is anonymous unless the organizer turns that off.</strong>{' '}
          Anonymous is the default a new ballot is created with.
        </p>
        <p>
          On an anonymous ballot a vote is stored against a pseudonym rather than a PIN:
          the first 32 hex characters of a SHA-256 hash over the PIN joined to a salt
          generated for that ballot alone. The salt sits in a column that is excluded from
          every grant in the database — no browser can read it, including the browser of
          the organizer who owns the ballot — and the function that computes the pseudonym
          is not on the public API either. So a vote row carries nothing that anyone
          working through the app can turn back into a PIN.
        </p>
        <p>
          On a ballot where anonymity has been turned off, the vote is deliberately
          attributable: the row records the id of the PIN that cast it, and the pseudonym
          column holds the plain text <code>pin:</code> followed by the six digits. A named
          vote being named is the point of the setting. That pseudonym column is not
          readable through the API by anyone — see <Anchor to="limits">known limits</Anchor>{' '}
          for what that fixed — so what a reader of a named ballot can follow is the
          opaque id of the PIN, not the PIN.
        </p>
        <p>
          <strong>Anonymity cannot be changed once a vote exists.</strong> The database
          refuses the edit, because switching would strand every key already recorded.
        </p>
        <p>
          <strong>Changing a vote does not erase the old one.</strong> Where the organizer
          allows changes, the standing rows are marked invalid and the new ones are written
          beside them; the count ignores the invalid ones. The earlier answer stays in the
          table until the ballot is deleted.
        </p>
        <p>
          <strong>One pseudonym per PIN per ballot.</strong> The same value stands for that
          voter on every question of that ballot. Nobody can say who it is, but anyone who
          can read the published rows can see that one voter answered two questions a
          particular way.
        </p>
      </Section>

      <Section id="published">
        <p>
          Publication is decided per question, not per ballot. A question becomes readable
          by the public when two things are true at once: the ballot publishes results at
          all, and that question can no longer be voted on — its gate is closed, or the
          whole ballot is. In open-mode ballots, where every question is answerable at
          once, that means the ballot closing. So a chair can close the first motion and
          announce it while the rest are still to come, and nobody can watch a count while
          it is still being taken. The live-updates channel applies the same rule per
          subscriber, so there is no way in through the side door.
        </p>
        <p>
          Two different moments, and it is worth keeping them apart. As soon as a ballot
          leaves draft, anyone holding its link can read its title and description, its
          questions and their descriptions, and its option labels — no PIN and no account.
          If it publishes results at all, they can also read turnout: how many PINs were
          issued for it and how many have voted.
        </p>
        <p>
          <strong>The votes themselves, and the count over them, wait for the test
          above.</strong> Until a question is finished, its votes are readable only by the
          organizer.
        </p>
        <p>
          With one deliberate exception. An <strong>X-of-N election</strong> publishes the
          elected and nothing else: no counts, no shares, no also-rans, and in a random
          order, because listing the winners by votes descending is the same ranking by
          other means. The outcome is who took the seats; the rest is a league table nobody
          stood for. The organizer still sees the full figures, because they need them to
          settle a tie at the cut-off.
        </p>
        <p>
          A results page that is holding questions back says how many, rather than showing
          a short list that reads like the whole ballot.
        </p>
        <p>Not public:</p>
        <ul>
          <li>
            <strong>PINs.</strong> The anonymous role holds no permission on the PIN
            table whatsoever — a voter’s own PIN is only ever checked inside a function.
            A signed-in organizer reaches the PINs on their own ballots and no others.
          </li>
          <li><strong>The salt</strong> behind the anonymous pseudonym.</li>
          <li><strong>The failed-attempt counters.</strong></li>
          <li>
            <strong>The record of what the retention job has deleted</strong> — see{' '}
            <Anchor to="kept">how long things are kept</Anchor>.
          </li>
          <li><strong>Draft ballots</strong>, and everything under them.</li>
          <li>
            <strong>Organizations as a list.</strong> There is no directory. Nothing public
            can enumerate the organizations on this deployment, and a signed-in organizer
            sees only their own. An organization’s own page does show its name,
            description, logo and published ballots to anyone holding its short name — that
            is what a scanned code carrying a single name lands on.
          </li>
          <li><strong>A running count</strong>, to anybody but the organizer.</li>
        </ul>
        <p>
          And no browser can write a vote directly. The vote tables carry no insert, update
          or delete permission for anyone; votes arrive only through functions that check
          the PIN, the gate and the question’s own rules — and the gate is re-checked at
          the moment of the click rather than when the page was drawn.
        </p>
      </Section>

      <Section id="limits">
        <div className="doc-callout">
          <h3>A named ballot used to publish its PINs. It no longer does.</h3>
          <p>
            On a ballot with anonymity turned off, the pseudonym column holds{' '}
            <code>pin:</code> and the six digits, and that column was part of the rows that
            become publicly readable once a question finishes — so anyone could read a
            PIN back out, and use it to vote on any question of that ballot still open.
          </p>
          <p>
            The anonymous and signed-in roles now hold no permission on that column at all,
            on any of the three vote tables. Because that is a grant rather than a rule
            about rows, no query can ask for it — not a voter’s, not an organizer’s. The
            rows stay public, the counts are unchanged, and a named vote is still tied to
            its voter across the ballot’s questions by an opaque id that is not a
            credential. It is recorded here because it was true of ballots run before it
            was fixed: a PIN printed on a slip for such a ballot should be treated as
            known.
          </p>
        </div>

        <p>Other things that are true and would be easier to leave unsaid:</p>
        <ul>
          <li>
            <strong>An organizer can break anonymity by elimination.</strong> Resetting one
            PIN voids exactly that PIN’s votes and deleting one removes them, so an
            organizer watching which rows change learns how that PIN voted. Anonymity holds
            against the public and against ordinary inspection; it does not hold against an
            organizer who sets out to break it.
          </li>
          <li>
            <strong>Anonymity is a matter of permissions, not of cryptography.</strong> The
            PIN list and the salt live in the same database. Anyone holding direct
            credentials to it — the operator, and the database host — could recompute the
            pseudonym for a PIN for as long as the ballot exists. What the salt buys is
            that nobody reaching the database through the app can, the organizer included.
          </li>
          <li>
            <strong>Superseded votes stay readable.</strong> Where a ballot allows changes,
            the row showing what someone answered first is readable by whoever can read the
            answer they settled on.
          </li>
          <li>
            <strong>Six digits is six digits.</strong> A million PINs per ballot, with a
            lock-out at twelve wrong guesses per browser per fifteen minutes. That is
            enough to make guessing impractical during a meeting, and not enough to be a
            secret worth keeping afterwards.
          </li>
          <li>
            <strong>A printed code can carry its own PIN.</strong> Off unless the organizer
            turns it on for a particular print run, because it makes the printed slip the
            credential: anyone who photographs it can vote with it. When it is on, the PIN
            is taken straight back out of the address bar after it is used, so it does not
            sit in the history of a shared phone.
          </li>
          <li>
            <strong>The record of a deletion outlives the ballot.</strong> When the
            retention job deletes a ballot it writes a receipt, and the receipt carries the
            ballot’s title along with its dates. No role can read that table over the API,
            but it is kept, and it is not itself on a schedule.
          </li>
          <li>
            <strong>The browser id is not scoped to one ballot.</strong> The same random id
            goes with PIN attempts on every ballot that browser tries. It links nothing to
            a person, but it does link attempts on different ballots from the same browser,
            in a table only the database’s own functions can read.
          </li>
        </ul>
      </Section>

      <Section id="kept">
        <p>
          <strong>Every ballot is deleted 30 days after it was created.</strong> A job
          inside the database runs once a day and takes everything past its date — the
          ballot, its questions, its options, its PINs, its votes and its failed-attempt
          counters all go together. A ballot also stops accepting votes the moment it
          expires, rather than whenever the job next happens to run.
        </p>
        <p>
          The organizer can push that date out by another 30 days from today, as often as
          they like, from the ballot’s own page — which carries the countdown — or bring it
          forward. They cannot set it further out than 30 days from now, which is why the
          column is readable from a browser but not writable by one.
        </p>
        <dl className="doc-facts">
          <dt>A ballot and everything under it</dt>
          <dd>30 days from creation; renewable by the organizer, and deletable sooner.</dd>

          <dt>The receipt for a deleted ballot — its id, its organization, its title and its dates</dt>
          <dd>Kept, with no schedule. Not readable over the API by any role.</dd>

          <dt>An organization: name, short name, description, contact text, logo</dt>
          <dd>
            Until it is removed. There is no schedule, and no button for it yet — see{' '}
            <Anchor to="removal">asking for something to be removed</Anchor>.
          </dd>

          <dt>An organizer account: email address, hashed password, sign-in timestamps</dt>
          <dd>Until it is removed. Same.</dd>

          <dt>The random browser id, <code>votingstation.fp</code></dt>
          <dd>In that browser only, until its site data is cleared.</dd>

          <dt>An organizer’s session, <code>votingstation.auth</code></dt>
          <dd>In that browser only, until they sign out or it expires.</dd>
        </dl>
        <p>
          Two quotas bound how much any one account can accumulate: five organizations per
          account, and twenty ballots per organization.
        </p>
      </Section>

      <Section id="lives">
        <p>Two services, and no others.</p>
        <p>
          <strong>GitHub</strong> hosts the page. It is a folder of static files published
          from the repository by GitHub Pages — there is no server of ours anywhere, and
          nothing about a vote is stored there. GitHub serves the requests and, as any host
          does, sees them; those logs are GitHub’s and are not handed to the repository’s
          owner.
        </p>
        <p>
          <strong>Supabase</strong> holds everything else: the Postgres database, the
          organizer accounts, the storage bucket the logos sit in, and the live-updates
          channel the chair’s monitor and the waiting phones listen on. Its own request
          logs record request metadata, including the address a request came from, and the
          operator can read them in the Supabase dashboard. Nothing in this app writes to
          those logs, reads them, or joins them to a vote — but they exist, and an honest
          account of where data lives has to include them.
        </p>
        <Todo>
          the region the Supabase project is hosted in, which is what decides where the
          data physically sits.
        </Todo>
        <p>
          <strong>The logo bucket is public to read.</strong> An organization’s mark has to
          be visible to a voter holding no account, and a printed sheet of slips cannot
          carry a freshly signed URL for every code, so anyone who has an object’s URL can
          fetch it. Writing is restricted to the owning organization’s own folder. Images
          are at most 2 MB and must be PNG, JPEG, WebP or SVG. Do not put anything in a
          logo that you would not publish.
        </p>
        <p>
          The address of the database and its publishable key are compiled into the page
          and visible in its source. That is deliberate: the key only ever grants the
          anonymous role, and what the anonymous role may do is exactly what{' '}
          <Anchor to="published">what is published</Anchor> and{' '}
          <Anchor to="limits">known limits</Anchor> describe.
        </p>
      </Section>

      <Section id="organizers">
        <p>
          An organizer’s account is an email address and a password held by the database
          provider’s authentication service, which stores the password only as a hash.
          Sign-in state is kept in the browser’s local storage rather than in a cookie.
        </p>
        <p>
          For their own organizations and nobody else’s, an organizer can see every ballot
          and its settings, every question, every PIN in plain text — they minted them —
          the full count at any time including while voting is open, how many PINs have not
          yet answered a given question, and, on a ballot that is not anonymous, which PIN
          cast which vote. They cannot read the salt, and on an anonymous ballot they
          cannot link a vote to a PIN through the app; <Anchor to="limits">known limits</Anchor>{' '}
          says what they can do around that.
        </p>
        <p>
          They cannot see another organizer’s organizations, ballots or PINs. That was once
          wrong — a read rule said “anyone” where it should have said “mine”, so any
          signed-in user could list every other user’s organizations — and it was fixed.
          Writes were never affected.
        </p>
      </Section>

      <Section id="removal">
        <p>
          <strong>If you are a voter</strong>, there is most likely nothing here that is
          yours to ask about. An anonymous vote is not linked to you by anything this
          system holds, and a named one is linked to a PIN rather than to a person. The
          link from a PIN to a human being exists only where the organizer keeps it, on
          their own list, outside this app. Ask them.
        </p>
        <p>
          <strong>If you are an organizer</strong>, you can delete a ballot, a question, an
          option or a PIN from the app at any time, and deleting a ballot takes everything
          under it. Deleting a PIN also deletes its votes, on purpose: a vote whose PIN no
          longer exists cannot be traced to anything, so keeping it is not keeping a record
          — it is keeping a number. Use <strong>reset</strong> instead when you want to
          void a PIN’s votes and keep the trail.
        </p>
        <p>
          The app has <strong>no button for deleting an organization or an account</strong>{' '}
          yet. Until it does, ask through the repository below and it will be done by hand.
        </p>
        <Todo>
          an address a person can write to, if the operator comes to need one for a formal
          data-protection request. The repository is the only route in today.
        </Todo>
      </Section>

      <Section id="terms">
        <p>Short, because there is not much here to promise.</p>
        <p>
          <strong>What this is.</strong> Software for running a token vote: issue PINs,
          open one question at a time, publish the count. It is offered free and as-is.
        </p>
        <p>
          <strong>No warranty, and no promise that it is up.</strong> There is no guarantee
          that the service is available, that a ballot survives, that a vote is recorded or
          that a count is right. It is a static page in front of a hosted database, and
          either can fail. Nothing here is a service level agreement. Do not run a vote
          whose outcome matters without keeping your own record of it.
        </p>
        <p>
          <strong>Ballots are deleted.</strong> Thirty days after creation, automatically —
          see <Anchor to="kept">how long things are kept</Anchor>. That is the design and not a
          fault. Renew a ballot you still need, or take what you need out of it before the
          date on its page.
        </p>
        <p>
          <strong>The organizer is responsible.</strong> For who is handed a PIN and for
          what follows if the wrong person gets one; for being entitled to run the vote
          they are running; for that vote complying with their organization’s own rules and
          with the law where they are; for everything they type into a question, an option,
          an organization’s description or its contact field; for having the right to use
          the logo they upload; and for the consequences of publishing a result. The
          organizer, not us, chooses whether a ballot is anonymous and whether it publishes
          — and the anonymity choice cannot be undone once a vote exists.
        </p>
        <p>
          <strong>Fair use.</strong> Do not guess PINs. Do not try to read what the rules
          withhold. Do not put load on the service that makes it unusable for someone else.
          The quotas — five organizations per account, twenty ballots per organization —
          are the shape the service is offered in.
        </p>
        <p>
          <strong>Removal.</strong> The operator may delete a ballot or an account being
          used to abuse the service or to harm someone, without notice. There is no appeal
          process, because there is nobody staffed to hear one.
        </p>
        <p>
          <strong>The code.</strong> The source is public at the repository below.
        </p>
        <Todo>
          a licence. No licence file is published in the repository, so publishing the
          source grants no right to reuse it; a human should decide and add one.
        </Todo>
        <p>
          <strong>No governing law is named here</strong>, and no company, address or
          jurisdiction is invented to fill the gap. If you need a named contracting party,
          this is not the service for you.
        </p>
      </Section>

      <Section id="contact">
        <p>There is one route in, and it is the repository.</p>
        <p>
          <a href={REPO} target="_blank" rel="noreferrer">github.com/PJKloppers/VotingStation</a>
        </p>
        <p>
          Open an issue there for a question, a correction, a removal request or a security
          report. A security report is welcome and will not be met badly; if it is serious,
          say so in the title.
        </p>
        <p>
          This page lives in that repository with the rest of the code, so its history is
          its change log: every change to it is a commit with a date and a diff. There is
          nothing to subscribe to and nothing to unsubscribe from — if you are relying on
          what it says, the repository is where to check.
        </p>
      </Section>

      {/* No repository pill here: the site footer below carries one, and two of
          them a centimetre apart read as a mistake. */}
      <p className="doc-foot">VotingStation · last reviewed 13 September 2026</p>
    </main>
  );
}
