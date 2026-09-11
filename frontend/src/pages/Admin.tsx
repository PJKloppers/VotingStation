/** The organizer's dashboard: their organizations, and each one's ballots. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from '../lib/api';
import { href, navigate } from '../lib/router';
import type { Ballot, Organization } from '../lib/types';
import { encodeQr, QUIET, qrPath, type QrCode } from '../lib/qr';
import { slugify } from '../lib/slug';
import { Banner, Card, Empty, Field, Pill, Spinner } from '../components/ui';

export function Admin() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [ballots, setBallots] = useState<Record<string, Ballot[]>>({});
  // Two quotas, held apart rather than as one object: the database may answer
  // with both at once, or a refused insert may teach us one of them alone.
  const [orgCap, setOrgCap] = useState<number | null>(null);
  const [ballotCap, setBallotCap] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [mine, caps] = await Promise.all([api.myOrganizations(), api.limits()]);
      setOrgs(mine);
      if (caps) {
        setOrgCap(caps.organizations_per_user);
        setBallotCap(caps.ballots_per_organization);
      }
      const pairs = await Promise.all(
        mine.map(async (o) => [o.id, await api.ballotsForOrg(o.id)] as const),
      );
      setBallots(Object.fromEntries(pairs));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your organizations.');
      setOrgs([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Not "Loading your ballots": that reads as the heading below it, to a person
  // skimming and to anything matching on text.
  if (orgs === null) return <main><Spinner label="Loading your organizations" /></main>;

  // Nothing to be the organizer of yet, so the page is the welcome rather than
  // an empty heading with a form under it. Narrow, because it is one column of
  // prose and two fields and nothing is beside it.
  if (orgs.length === 0) {
    return (
      <main className="narrow">
        {error ? <Banner kind="error">{error}</Banner> : null}
        <NewOrganization first count={0} cap={orgCap} onDone={load} onRefused={setOrgCap} />
      </main>
    );
  }

  return (
    <main>
      <div className="section-head">
        <div>
          <p className="eyebrow">Organizer</p>
          <h1>Your ballots</h1>
        </div>
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      <div className="stack">
        {orgs.map((org) => (
          <Card key={org.id}>
            <div className="row">
              <div className="grow">
                <p className="eyebrow">Organization</p>
                <h2>{org.name}</h2>
                <p className="faint mono">/{org.slug}</p>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              {(ballots[org.id] ?? []).length === 0
                ? <Empty>No ballots yet.</Empty>
                : (ballots[org.id] ?? []).map((b) => (
                    <BallotRow key={b.id} ballot={b} onDeleted={load} />
                  ))}
            </div>

            <NewBallot orgId={org.id} orgSlug={org.slug}
                       count={(ballots[org.id] ?? []).length} cap={ballotCap}
                       onDone={load} onRefused={setBallotCap} />
          </Card>
        ))}

        <NewOrganization count={orgs.length} cap={orgCap}
                         onDone={load} onRefused={setOrgCap} />
      </div>
    </main>
  );
}

/**
 * The number out of a quota refusal.
 *
 * `app.enforce_organization_quota` and `app.enforce_ballot_quota` raise "... at
 * most 20 ballots ...", and while `app` stays off the REST surface that
 * sentence is the only place a client can read a limit from. So rather than
 * print it once and forget it, the dashboard keeps the number and counts
 * against it from then on.
 */
function capFromRefusal(message: string): number | null {
  const found = /at most (\d+)/.exec(message);
  return found ? Number(found[1]) : null;
}

/**
 * How much room is left, beside the button that would use it.
 *
 * Without a cap this is a bare count -- a ceiling nobody has confirmed is
 * worse than no ceiling at all, because an organizer would plan around it.
 */
function Quota({ used, cap, noun }: { used: number; cap: number | null; noun: string }) {
  const plural = used === 1 ? noun : `${noun}s`;
  if (cap === null) {
    return <span className="quota"><span className="quota-note">{used} {plural}</span></span>;
  }
  const full = used >= cap;
  return (
    <span className="quota" data-full={full ? '' : undefined}>
      <span className="quota-rail" aria-hidden="true">
        <i style={{ width: `${Math.min(1, used / cap) * 100}%` }} />
      </span>
      <span className="quota-note">
        {used} of {cap} {noun}s{full ? ' — delete one to make room' : ''}
      </span>
    </span>
  );
}

/**
 * One ballot on the dashboard.
 *
 * The row used to be a single button that opened the ballot, which left no
 * room for anything else -- and the dashboard is exactly where a stray ballot
 * is noticed, so it is where deleting one belongs. A draft has nothing behind
 * it and goes on a second click; anything published has votes behind it and
 * costs the same typed title as the Settings tab.
 */
function BallotRow({ ballot, onDeleted }: { ballot: Ballot; onDeleted: () => void }) {
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const needsTitle = ballot.status !== 'draft';
  const ready = !needsTitle || typed.trim() === ballot.title.trim();

  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.deleteBallot(ballot.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete it.');
      setBusy(false);
    }
  };

  return (
    <div className="ballot-row">
      <div className="row">
        <button className="ballot-open grow" onClick={() => navigate(`/manage/${ballot.id}`)}>
          <span className="lobby-title">{ballot.title}</span>
          <span className="faint" style={{ display: 'block' }}>
            {ballot.mode === 'gated' ? 'One question at a time' : 'All questions at once'}
            {' · '}<span className="mono">/{ballot.slug}</span>
          </span>
        </button>
        <Pill tone={ballot.status === 'live' ? 'live' : ballot.status === 'closed' ? 'defeated' : ''}>
          {ballot.status}
        </Pill>
        {!arming
          ? <button className="danger small" onClick={() => setArming(true)}>Delete</button>
          : null}
      </div>

      {arming ? (
        <div className="ballot-confirm">
          <p className="faint">
            Deleting &ldquo;{ballot.title}&rdquo; takes its questions, its PINs and every
            vote on it. There is no undo.
          </p>
          {error ? <Banner kind="error">{error}</Banner> : null}
          <div className="row">
            {needsTitle ? (
              <input
                className="grow"
                name="confirm_title"
                autoFocus
                autoComplete="off"
                placeholder={`Type "${ballot.title}" to confirm`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            ) : null}
            <button className="ghost small"
                    onClick={() => { setArming(false); setTyped(''); setError(''); }}>
              Cancel
            </button>
            <button className="btn-danger solid small" disabled={busy || !ready}
                    onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Naming an organization, and -- on a first visit -- the whole page.
 *
 * The two readings are far apart. One is a second home for ballots, opened
 * from a button under a list of the first; the other is the only thing a new
 * organizer has been given to do, and a lone pair of fields under a heading
 * reads as a form that went astray rather than as a welcome. So the first-run
 * variant keeps the page to itself: it says what an organization is for, and
 * what comes after naming one.
 */
function NewOrganization({ onDone, onRefused, count, cap, first = false }: {
  onDone: () => void; onRefused: (cap: number) => void;
  count: number; cap: number | null; first?: boolean;
}) {
  const [open, setOpen] = useState(first);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const full = cap !== null && count >= cap;
  // `slugify` answers "ballot" for anything too short to make a slug of, which
  // on an untouched first-run screen reads as the link they are being given.
  // Nothing is derived until there is a name to derive it from.
  const derived = name.trim() ? slugify(name, 'organization') : '';

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createOrganization({
        name, slug: slug || derived, description: '', contact: '',
      });
      setName(''); setSlug(''); setOpen(false);
      onDone();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create it.';
      setError(message);
      const learned = capFromRefusal(message);
      if (learned !== null) onRefused(learned);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="create-foot">
        <button className="ghost" disabled={full} onClick={() => setOpen(true)}>
          + New organization
        </button>
        <Quota used={count} cap={cap} noun="organization" />
      </div>
    );
  }

  return (
    // Card spreads what it is given after its own class, so the list is
    // handed over in full rather than added to.
    <Card className={first ? 'card welcome' : 'card'}>
      {first ? (
        <div className="create-head">
          <p className="eyebrow">First things first</p>
          <h1>Set up your organization</h1>
          <p className="lede">
            Every ballot belongs to an organization — the name a voter sees at the top of
            the paper, and the word that stands in its link. Name it once and everything
            you run from here lives inside it.
          </p>
          <ol className="welcome-steps">
            <li>Name your organization.</li>
            <li>Add a ballot and the questions it asks.</li>
            <li>Hand out PINs, then take it live.</li>
          </ol>
        </div>
      ) : (
        <div className="create-head">
          <p className="eyebrow">Organization</p>
          <h2>New organization</h2>
          <p className="create-note">
            A separate name, a separate link, and a ballot list of its own.
          </p>
        </div>
      )}

      {error ? <Banner kind="error">{error}</Banner> : null}

      <form onSubmit={create}>
        <Field label="Name" help="What a voter sees at the top of every ballot you run.">
          <input required autoFocus value={name} name="org_name"
                 onChange={(e) => setName(e.target.value)}
                 placeholder="Demo Society" />
        </Field>
        <Field label="Short name for links" help="Lower case letters, digits and dashes.">
          <input className="mono" name="org_slug"
                 placeholder="demo-society"
                 value={slug || derived}
                 onChange={(e) => setSlug(slugify(e.target.value, 'organization'))} />
        </Field>
        <div className="create-actions">
          <button type="submit" className="primary" disabled={busy || !name.trim() || full}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
          {!first ? (
            <button type="button" className="ghost"
                    onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
          ) : null}
          {!first ? <Quota used={count} cap={cap} noun="organization" /> : null}
        </div>
      </form>
    </Card>
  );
}

/**
 * Starting a ballot, from inside the organization it will belong to.
 *
 * One field hung off a rule read as something left over rather than as a step,
 * so the form takes a panel of its own inside the card -- it is a different
 * thing from the list of ballots above it, and it should look like one.
 */
function NewBallot({ orgId, orgSlug, count, cap, onDone, onRefused }: {
  orgId: string; orgSlug: string; count: number; cap: number | null;
  onDone: () => void; onRefused: (cap: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const full = cap !== null && count >= cap;
  const typed = title.trim() !== '';

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const ballot = await api.createBallot({
        org_id: orgId, title, slug: slugify(title), description: '',
      });
      setTitle(''); setOpen(false);
      onDone();
      navigate(`/manage/${ballot.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create it.';
      setError(message);
      // the form stays open: the count beside the button has just filled up,
      // and closing it would take the reason away with it
      const learned = capFromRefusal(message);
      if (learned !== null) onRefused(learned);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="create-foot ruled">
        <button className="ghost small" disabled={full} onClick={() => setOpen(true)}>
          + New ballot
        </button>
        <Quota used={count} cap={cap} noun="ballot" />
      </div>
    );
  }

  return (
    <form className="create-panel" onSubmit={create}>
      <div className="create-head">
        <h3>New ballot</h3>
        <p className="create-note">
          It starts as a draft. You add the questions next, and nobody can vote until
          you publish it.
        </p>
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      <Field label="Ballot title">
        <input required autoFocus value={title} name="ballot_title"
               onChange={(e) => setTitle(e.target.value)}
               placeholder="Annual General Meeting 2026" />
      </Field>

      {/* the slug is derived and never asked for, so without this an organizer
          finds out what address they made only after making it */}
      <p className="slug-preview" aria-live="polite">
        <span className="slug-label">Its link</span>
        {typed ? (
          <code className="slug-url">
            <span className="site">/{orgSlug}</span>
            <span className="leaf">/{slugify(title)}</span>
          </code>
        ) : (
          <span className="slug-empty">appears here as you type</span>
        )}
      </p>

      <div className="create-actions">
        <button type="submit" className="primary" disabled={busy || !typed || full}>
          {busy ? 'Creating…' : 'Create ballot'}
        </button>
        <button type="button" className="ghost"
                onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
        <Quota used={count} cap={cap} noun="ballot" />
      </div>
    </form>
  );
}


/**
 * The three ways into a ballot, and a code for the one a hall has to reach
 * without typing a uuid.
 *
 * What each link shows turns on the ballot's state, so the notes are built
 * from the ballot rather than written once. The results link especially: it is
 * the organizer's alone until the ballot is closed *and* publishing is on, and
 * saying otherwise is how an organizer ends up handing out a link that opens
 * on nothing.
 */
export function AdminLinks({ ballot }: { ballot: Ballot }) {
  const base = `${window.location.origin}${window.location.pathname}`;
  const voteUrl = `${base}${href(`/vote/${ballot.id}`)}`;
  const [projecting, setProjecting] = useState(false);
  // a few thousand field operations; not slow, but it has no reason to run
  // again every time something else on the page re-renders
  const code = useMemo(() => encodeQr(voteUrl), [voteUrl]);

  useEffect(() => {
    if (!projecting) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setProjecting(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [projecting]);

  return (
    <Card>
      <h3>Links</h3>
      <p className="lede">Three ways into this ballot. Only the first is meant to be handed out.</p>

      <div className="share-set">
        <ShareLink label="Voting link" base={base} route="/vote/" id={ballot.id}
                   note={votingNote(ballot)}
                   aside={code ? (
                     <div className="qr">
                       <div className="qr-panel"><QrImage code={code} /></div>
                       <button type="button" className="ghost small"
                               onClick={() => setProjecting(true)}>Project it</button>
                     </div>
                   ) : null} />

        <ShareLink label="Results link" base={base} route="/results/" id={ballot.id}
                   note={resultsNote(ballot)} />

        <ShareLink label="Live monitor" base={base} route="/live/" id={ballot.id}
                   note={'The count as it lands, question by question — what a chairperson puts on '
                         + 'the projector. It opens for you and for nobody else.'} />
      </div>

      {projecting && code ? (
        <div className="qr-stage" role="dialog" aria-modal="true" aria-label="Voting code"
             onClick={() => setProjecting(false)}>
          <div className="qr-panel"><QrImage code={code} /></div>
          <p className="qr-stage-url">{voteUrl}</p>
          <button type="button" className="ghost small" autoFocus
                  onClick={() => setProjecting(false)}>Close</button>
        </div>
      ) : null}
    </Card>
  );
}

function votingNote(ballot: Ballot): string {
  if (ballot.status === 'draft') {
    return 'Where voters enter their PIN. Nobody gets in until you take the ballot live.';
  }
  if (ballot.status === 'closed') {
    return 'Voting has closed: anyone opening this now is shown the closing message.';
  }
  return 'Where voters enter their PIN. Project the code and the room can scan it instead of typing.';
}

/**
 * The results link is public only once the ballot has closed, and only if the
 * organizer asked for it -- `app.votes_readable` wants both. Three states, and
 * the card says which one it is in rather than making a promise for all three.
 */
function resultsNote(ballot: Ballot): string {
  if (!ballot.results_public) {
    return 'Yours alone. Switch on “Publish the results once voting closes” under Settings '
      + 'to let anyone else open it.';
  }
  if (ballot.status === 'closed') {
    return 'Public. The ballot is closed and publishing is on, so anyone holding this link '
      + 'can read the result.';
  }
  return 'Yours alone for now. Publishing is on, so this opens to everyone the moment you '
    + 'close the ballot — while voting runs, the tally is yours.';
}

/**
 * One link: what it is for, the link itself, and a copy button.
 *
 * The link wraps rather than scrolling inside a one-line box. A uuid in a box
 * that width shows its tail and nothing else, which is the half nobody can
 * read anyway -- where the whole thing, broken over three lines, at least says
 * which ballot and which route.
 */
function ShareLink({ label, note, base, route, id, aside }: {
  label: string; note: string; base: string; route: string; id: string; aside?: ReactNode;
}) {
  const url = `${base}${href(`${route}${id}`)}`;
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle');
  const shown = useRef<HTMLElement>(null);

  // selecting the text is the clipboard's fallback, not a nicety:
  // navigator.clipboard exists only in a secure context, and an organizer
  // running this off a laptop on the hall's own wifi is on plain http.
  const select = () => {
    const node = shown.current;
    const selection = window.getSelection();
    if (!node || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      select();
      setState('select');
    }
  };

  useEffect(() => {
    if (state !== 'copied') return;
    const settle = setTimeout(() => setState('idle'), 2200);
    return () => clearTimeout(settle);
  }, [state]);

  return (
    <div className="share">
      <div className="share-body">
        <h4>{label}</h4>
        <p className="share-note">{note}</p>
        <div className="share-link">
          <code className="share-url" ref={shown} tabIndex={0} onFocus={select}>
            <span className="site">{base}</span>
            <span className="route">{href(route)}</span>
            <span className="tail">{id}</span>
          </code>
          <button type="button" className="ghost small share-copy" data-state={state}
                  onClick={() => void copy()}>
            <span aria-live="polite">{state === 'copied' ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        {state === 'select' ? (
          <p className="share-fallback" role="status">
            This page is not on https, so the browser keeps the clipboard to itself.
            The link is selected — press Ctrl-C.
          </p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

function QrImage({ code }: { code: QrCode }) {
  const span = code.size + QUIET * 2;
  return (
    <svg viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges"
         role="img" aria-label="QR code for the voting link">
      <path d={qrPath(code)} />
    </svg>
  );
}
