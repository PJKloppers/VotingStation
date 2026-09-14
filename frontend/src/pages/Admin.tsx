/** The organizer's dashboard: their organizations, and each one's ballots. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from '../lib/api';
import { appBase, href, navigate } from '../lib/router';
import type { Ballot, Organization, OrganizationImage } from '../lib/types';
import { encodeQr, QUIET, qrPath, type QrCode } from '../lib/qr';
import { slugify, slugProblem } from '../lib/slug';
import { Banner, Card, Check, Empty, Field, Modal, Pill, Spinner, Step } from '../components/ui';

export function Admin() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [ballots, setBallots] = useState<Record<string, Ballot[]>>({});
  // Two quotas, held apart rather than as one object: the database may answer
  // with both at once, or a refused insert may teach us one of them alone.
  const [orgCap, setOrgCap] = useState<number | null>(null);
  const [ballotCap, setBallotCap] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [mine, caps, marks] = await Promise.all([
        api.myOrganizations(), api.limits(), api.myOrgLogos(),
      ]);
      setLogos(marks);
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
              <OrgMarkThumb path={logos[org.id]} />
              <div className="grow">
                <p className="eyebrow">Organization</p>
                <h2>{org.name}</h2>
                <p className="faint mono">/{org.slug}</p>
              </div>
              <button className="ghost small" onClick={() => setSettingsFor(org.id)}>
                Settings
              </button>
            </div>

            <OrgSettings
              org={org}
              open={settingsFor === org.id}
              onClose={() => setSettingsFor(null)}
              onSaved={load}
            />

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
/**
 * Everything about an organization that is not its ballots.
 *
 * Two settings for now, and a modal rather than a page: both are things you
 * change once and then leave, and neither is worth losing your place on the
 * dashboard for.
 */
function OrgSettings({ org, open, onClose, onSaved }: {
  org: Organization; open: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(org.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  // Reopening should show what is stored, not what was half-typed last time.
  useEffect(() => { if (open) { setName(org.name); setError(''); setSaved(false); } },
           [open, org.name]);

  const rename = async () => {
    setSaving(true); setError('');
    try {
      await api.updateOrganization(org.id, { name: name.trim() });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const dirty = name.trim() !== org.name && name.trim().length > 0;

  return (
    <Modal open={open} title={`${org.name} settings`} onClose={onClose}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {saved && !dirty ? <Banner kind="good">Saved.</Banner> : null}

      <Field label="Name">
        <input name="org_rename" value={name}
               onChange={(e) => { setName(e.target.value); setSaved(false); }} />
      </Field>
      <p className="faint" style={{ marginTop: -8 }}>
        The link stays <span className="mono">/{org.slug}</span>; renaming does not
        move anyone's ballots.
      </p>
      <div className="row">
        <button className="primary" disabled={!dirty || saving} onClick={() => void rename()}>
          {saving ? 'Saving…' : 'Save name'}
        </button>
      </div>

      <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--rule-soft)' }}>
        <h3 style={{ marginBottom: 4 }}>Mark</h3>
        <OrgLogo orgId={org.id} onChanged={onSaved} />
      </div>

      <DeleteOrganization org={org} onDeleted={() => { onClose(); onSaved(); }} />
    </Modal>
  );
}

/**
 * The end of an organization.
 *
 * Last in the modal and behind its own arming click, because it is the one
 * control here that cannot be undone and the other two are things you come to
 * this modal to do. The count is read before arming and stated plainly: an
 * organizer with one stale test organization and one real one should not have
 * to remember which is which at the moment of deleting it.
 *
 * The name has to be typed, the same price the dashboard asks for a published
 * ballot -- and this is every ballot at once.
 */
function DeleteOrganization({ org, onDeleted }: {
  org: Organization; onDeleted: () => void;
}) {
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [count, setCount] = useState<number | null>(null);

  // Only once it is armed: the dashboard already made one request per
  // organization to draw this modal's card, and this is a question nobody
  // asked until they reached for the button.
  useEffect(() => {
    if (!arming) return;
    let live = true;
    api.ballotsForOrg(org.id)
      .then((b) => { if (live) setCount(b.length); })
      .catch(() => { if (live) setCount(null); });
    return () => { live = false; };
  }, [arming, org.id]);

  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.deleteOrganization(org.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete it.');
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--rule-soft)' }}>
      <h3 style={{ marginBottom: 4 }}>Delete this organization</h3>

      {!arming ? (
        <>
          <p className="faint">
            Takes its ballots with it, and every PIN and vote on them.
          </p>
          <button className="danger" onClick={() => setArming(true)}>
            Delete {org.name}
          </button>
        </>
      ) : (
        <div className="ballot-confirm">
          <p className="faint">
            Deleting &ldquo;{org.name}&rdquo; takes{' '}
            {count === null ? 'its ballots'
              : count === 0 ? 'nothing else — it has no ballots'
              : count === 1 ? 'its 1 ballot'
              : `its ${count} ballots`}
            , every PIN and vote on {count === 1 ? 'it' : 'them'}, and its mark.
            There is no undo.
          </p>
          {error ? <Banner kind="error">{error}</Banner> : null}
          <div className="row">
            <input
              className="grow"
              name="confirm_org"
              autoFocus
              autoComplete="off"
              placeholder={`Type "${org.name}" to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button className="ghost small"
                    onClick={() => { setArming(false); setTyped(''); setError(''); }}>
              Cancel
            </button>
            <button className="btn-danger solid small"
                    disabled={busy || typed.trim() !== org.name.trim()}
                    onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The mark beside an organization's name.
 *
 * Told, not fetched: it used to load its own and so never noticed one being
 * uploaded in the modal above it -- the card stayed blank until a reload. The
 * dashboard loads every mark in one query, so one refresh moves all of them.
 */
function OrgMarkThumb({ path }: { path: string | undefined }) {
  const src = api.logoUrl(path);
  if (!src) return null;
  return <span className="org-thumb"><img src={src} alt="" /></span>;
}

/**
 * An organization's mark.
 *
 * It ends up in three places a voter sees -- the ballot header, the printed
 * slips, and the middle of the QR on each slip.
 */
function OrgLogo({ orgId, onChanged }: { orgId: string; onChanged?: () => void }) {
  const [image, setImage] = useState<OrganizationImage | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.orgLogo(orgId).then(setImage).catch(() => setImage(null));
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      setImage(await api.uploadOrgLogo(orgId, file));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload that.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const drop = async () => {
    if (!confirm('Remove this organization\u2019s mark?')) return;
    setBusy(true); setError('');
    try { await api.removeOrgLogo(orgId); setImage(null); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove it.'); }
    finally { setBusy(false); }
  };

  if (image === undefined) return null;
  const src = api.logoUrl(image?.path);

  return (
    <div className="org-mark">
      <div className="org-mark-frame">
        {src
          ? <img src={src} alt="" />
          : <span className="faint" aria-hidden="true">—</span>}
      </div>
      <div className="grow">
        <p className="faint" style={{ margin: 0 }}>
          {src
            ? 'Shown on the ballot, on printed slips, and inside their QR codes.'
            : 'No mark yet. It would show on the ballot, on printed slips, and inside their QR codes.'}
        </p>
        {error ? <Banner kind="error">{error}</Banner> : null}
        <div className="row" style={{ marginTop: 8 }}>
          <input ref={input} type="file" name="org_logo" hidden
                 accept="image/png,image/jpeg,image/webp,image/svg+xml"
                 onChange={(e) => void choose(e.target.files?.[0])} />
          <button className="ghost small" disabled={busy}
                  onClick={() => input.current?.click()}>
            {busy ? 'Working…' : src ? 'Replace mark' : 'Add a mark'}
          </button>
          {src
            ? <button className="danger small" disabled={busy} onClick={() => void drop()}>Remove</button>
            : null}
        </div>
      </div>
    </div>
  );
}

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
/** What we currently believe about a slug the organizer is typing. */
type Availability = 'idle' | 'checking' | 'free' | 'taken' | 'unknown';

/**
 * Asks the database whether a slug is free, a moment after typing stops.
 *
 * Debounced, because this fires on a keystroke and the answer to "dem" is of no
 * use to anybody. Out-of-order replies are dropped by sequence rather than by
 * timing: a slow answer for "demo-so" must not overwrite a fast one for
 * "demo-society", which is the bug this kind of field always has.
 */
function useSlugAvailability(slug: string): Availability {
  const [state, setState] = useState<Availability>('idle');
  const latest = useRef(0);

  useEffect(() => {
    if (!slug) { setState('idle'); return; }
    setState('checking');
    const mine = ++latest.current;
    const timer = setTimeout(() => {
      api.organizationSlugAvailable(slug)
        .then((free) => { if (mine === latest.current) setState(free ? 'free' : 'taken'); })
        .catch(() => { if (mine === latest.current) setState('unknown'); });
    }, 400);
    return () => clearTimeout(timer);
  }, [slug]);

  return state;
}

function SlugStatus({ slug, shape, state }: {
  slug: string; shape: string | null; state: Availability;
}) {
  if (!slug) return null;

  const [tone, said] = shape !== null
    ? ['bad', shape] as const
    : state === 'checking' ? ['checking', 'Checking whether that is free\u2026'] as const
    : state === 'free' ? ['good', `\u201c${slug}\u201d is free.`] as const
    : state === 'taken' ? ['bad', `\u201c${slug}\u201d is taken. Try another \u2014 it stands in the link, so it has to be its own.`] as const
    : state === 'unknown' ? ['faint', 'Could not check that just now; you can still try.'] as const
    : ['faint', ''] as const;

  if (!said) return null;

  return (
    <p className={`slug-status ${tone}`} aria-live="polite">
      {state === 'checking' && shape === null
        ? <span className="slug-spinner" aria-hidden="true" /> : null}
      {said}
    </p>
  );
}

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
  const wanted = slug || derived;
  const shape = slugProblem(wanted);
  const availability = useSlugAvailability(shape ? '' : wanted);

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
                 value={wanted}
                 onChange={(e) => setSlug(slugify(e.target.value, 'organization'))} />
        </Field>

        {/* Said under the field as it is typed rather than after the form is
            sent: the short name stands in the link, and finding out it was
            taken by submitting means re-reading a form you thought was done. */}
        <SlugStatus slug={wanted} shape={shape} state={availability} />

        <div className="create-actions">
          <button type="submit" className="primary"
                  disabled={busy || !name.trim() || full || shape !== null
                            || availability === 'taken' || availability === 'checking'}>
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
  const [mode, setMode] = useState<Ballot['mode']>('gated');
  const [anonymous, setAnonymous] = useState(true);
  const [publish, setPublish] = useState(true);
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
        mode, anonymous, results_public: publish,
      });
      setTitle(''); setMode('gated'); setAnonymous(true); setPublish(true);
      setOpen(false);
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

  const shut = () => { setOpen(false); setError(''); };

  /*
   * In a modal rather than in the card. Opening it inline pushed the
   * organization's ballots apart and grew the page by the length of the form,
   * so starting a ballot moved everything an organizer was looking at. A
   * dialog leaves the list where it is and puts the flow on top of it.
   */
  return (
    <>
      <div className="create-foot ruled">
        <button className="ghost small" disabled={full} onClick={() => setOpen(true)}>
          + New ballot
        </button>
        <Quota used={count} cap={cap} noun="ballot" />
      </div>

      <Modal open={open} title="New ballot" onClose={shut}>
        <form onSubmit={create}>
          <p className="create-note">
            It starts as a draft. You add the questions next, and nobody can vote until
            you publish it.
          </p>

          {error ? <Banner kind="error">{error}</Banner> : null}

      <Step n={1} title="What is this ballot called?">
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
      </Step>

      {typed ? (
        <>
          <Step n={2} title="How does the meeting run?">
            <div className="kind-choice two" role="radiogroup" aria-label="How the meeting runs">
              {([
                ['gated', 'One question at a time',
                 'You open each question from the chair. Nobody can run ahead.'],
                ['open', 'All at once',
                 'The whole ballot is in front of every voter, to work through at their own pace.'],
              ] as const).map(([value, name, blurb]) => (
                <button key={value} type="button" role="radio"
                        aria-checked={mode === value}
                        className={`kind${mode === value ? ' picked' : ''}`}
                        onClick={() => setMode(value)}>
                  <span className="kind-title">{name}</span>
                  <span className="kind-blurb">{blurb}</span>
                </button>
              ))}
            </div>
          </Step>

          <Step n={3} title="Who sees what?">
            {/* Both of these are hard to change later for good reasons: the
                database refuses to switch anonymity once a vote exists, because
                it would strand every key already recorded. Better asked now
                than discovered on the Settings tab afterwards. */}
            <Check label="Secret ballot" checked={anonymous} onChange={setAnonymous}
                   help="Votes are recorded against a one-way pseudonym, not the PIN. This cannot be changed once anyone has voted." />
            <Check label="Publish the results" checked={publish} onChange={setPublish}
                   help="Anyone with the link sees each question's count once its gate closes. Off keeps them to you." />
          </Step>
        </>
      ) : null}

          <div className="create-actions">
            <button type="submit" className="primary" disabled={busy || !typed || full}>
              {busy ? 'Creating…' : 'Create ballot'}
            </button>
            <button type="button" className="ghost" onClick={shut}>Cancel</button>
            <Quota used={count} cap={cap} noun="ballot" />
          </div>
        </form>
      </Modal>
    </>
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
  const base = appBase();
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
