/**
 * The front page.
 *
 * A voter arrives holding a PIN and nothing else, so that is what the page
 * asks for. A PIN is unique per ballot rather than globally, so it is looked
 * up: one match goes straight through, several ask which, none says so.
 *
 * The directory of organizations is still here, below, for a reader who wants
 * to see a published result or find the organizer they were expecting.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { handOffPin } from '../lib/handoff';
import { href, navigate } from '../lib/router';
import type { Ballot, OrgListing, PinMatch } from '../lib/types';
import { Banner, Card, Empty, Pill, Spinner } from '../components/ui';

export function Home() {
  return (
    <main className="narrow">
      <div className="stack">
        <header style={{ maxWidth: '40ch' }}>
          <p className="eyebrow">Token voting</p>
          <h1>Enter your PIN to vote.</h1>
        </header>
        <PinGate />
        <Directory />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------- the PIN box */

function PinGate() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<PinMatch[] | null>(null);

  const open = useCallback((match: PinMatch, thePin: string) => {
    handOffPin(match.ballot_id, thePin);
    navigate(`/vote/${match.ballot_id}`);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setChoices(null);
    try {
      const answer = await api.findBallotsForPin(pin);
      if (!answer.ok) { setError(answer.error); return; }

      // One ballot is the ordinary case: go, without asking anything.
      if (answer.ballots.length === 1) open(answer.ballots[0]!, pin);
      else setChoices(answer.ballots);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <p className="muted">
        Your organizer issued you a six-digit PIN. It is the only thing you need.
      </p>
      {error ? <Banner kind="error">{error}</Banner> : null}

      <form onSubmit={submit} style={{ marginTop: 14 }}>
        <input
          className="pin-entry"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          name="pin"
          aria-label="Your six-digit PIN"
          placeholder="000000"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setChoices(null); setError('');
          }}
        />
        <button type="submit" className="primary block" style={{ marginTop: 14 }}
                disabled={busy || pin.length !== 6}>
          {busy ? 'Checking…' : 'Open my ballot'}
        </button>
      </form>

      {choices ? (
        <div style={{ marginTop: 18 }}>
          <p className="faint">
            That PIN opens more than one ballot. Which one are you voting on?
          </p>
          {choices.map((c) => (
            <button key={c.ballot_id} className="lobby-item" onClick={() => open(c, pin)}>
              <span className="lobby-body">
                <span className="lobby-title">{c.title}</span>
                <span className="faint" style={{ display: 'block' }}>{c.org_name}</span>
              </span>
              <Pill tone={c.status === 'live' ? 'live' : 'closed'}>{c.status}</Pill>
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/* ----------------------------------------------------------- the directory */

type Ballots = 'loading' | Ballot[];

function Directory() {
  const [orgs, setOrgs] = useState<OrgListing[] | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [ballots, setBallots] = useState<Record<string, Ballots>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    api.publicOrganizations()
      .then(setOrgs)
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Could not load the directory.');
        setOrgs([]);
      });
  }, []);

  const toggle = useCallback((orgId: string) => {
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });

    // Fetch once, then keep it: reopening an organization is instant.
    setBallots((current) => {
      if (current[orgId]) return current;
      api.publicBallotsForOrg(orgId)
        .then((list) => setBallots((c) => ({ ...c, [orgId]: list })))
        .catch(() => setBallots((c) => ({ ...c, [orgId]: [] })));
      return { ...current, [orgId]: 'loading' };
    });
  }, []);

  return (
    <>
      <div className="section-head"><h2>Or browse organizations</h2></div>

      {error ? <Banner kind="error">{error}</Banner> : null}
      {orgs === null ? <Spinner label="Loading the directory" /> : null}
      {orgs?.length === 0 && !error
        ? <Empty>No organization has published a ballot yet.</Empty>
        : null}

      {orgs?.map((org) => (
        <OrganizationCard
          key={org.id}
          org={org}
          open={opened.has(org.id)}
          ballots={ballots[org.id]}
          onToggle={() => toggle(org.id)}
        />
      ))}
    </>
  );
}

function OrganizationCard({ org, open, ballots, onToggle }: {
  org: OrgListing; open: boolean; ballots: Ballots | undefined; onToggle: () => void;
}) {
  const panelId = `org-${org.id}`;

  return (
    <Card>
      {/* The heading wraps the button, so the disclosure is the heading rather
          than a control sitting beside one. */}
      <h3 style={{ margin: 0 }}>
        <button
          className="row"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          style={{
            width: '100%', padding: 0, minHeight: 44,
            background: 'none', border: 0, font: 'inherit', color: 'inherit',
            textAlign: 'left', justifyContent: 'flex-start',
          }}
        >
          <span className="grow">{org.name}</span>
          <Pill tone="accent">
            {org.ballot_count} {org.ballot_count === 1 ? 'ballot' : 'ballots'}
          </Pill>
          <span className="faint" aria-hidden="true" style={{ fontSize: '1.1rem', width: 16 }}>
            {open ? '▾' : '▸'}
          </span>
        </button>
      </h3>

      {org.description ? <p className="faint" style={{ marginTop: 6 }}>{org.description}</p> : null}

      {open ? (
        <div id={panelId} style={{ marginTop: 14 }}>
          {ballots === undefined || ballots === 'loading'
            ? <Spinner label="Loading ballots" />
            : ballots.length === 0
              ? <p className="faint">Nothing published right now.</p>
              : ballots.map((b) => <BallotRow key={b.id} ballot={b} />)}
          {org.contact
            ? <p className="faint" style={{ marginTop: 14 }}>Contact: {org.contact}</p>
            : null}
        </div>
      ) : null}
    </Card>
  );
}

function BallotRow({ ballot }: { ballot: Ballot }) {
  return (
    <div style={{ padding: '14px 0', borderTop: '1px solid var(--rule-soft)' }}>
      <div className="row">
        <div className="grow">
          <strong>{ballot.title}</strong>
          {ballot.description ? <div className="faint">{ballot.description}</div> : null}
        </div>
        <Pill tone={ballot.status === 'live' ? 'live' : 'closed'}>{ballot.status}</Pill>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {ballot.status === 'live'
          ? <a className="btn btn-primary small" href={href(`/vote/${ballot.id}`)}>Vote</a>
          : null}
        {ballot.results_public
          ? <a className="btn btn-ghost small" href={href(`/results/${ballot.id}`)}>Results</a>
          : null}
      </div>
    </div>
  );
}
