/** The organizer's dashboard: their organizations, and each one's ballots. */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { href, navigate } from '../lib/router';
import type { Ballot, Organization } from '../lib/types';
import { slugify } from '../lib/slug';
import { Banner, Card, Empty, Field, Pill, Spinner } from '../components/ui';

export function Admin() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [ballots, setBallots] = useState<Record<string, Ballot[]>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const mine = await api.myOrganizations();
      setOrgs(mine);
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

  if (orgs === null) return <main><Spinner label="Loading your ballots" /></main>;

  return (
    <main>
      <div className="section-head">
        <div>
          <p className="eyebrow">Organizer</p>
          <h1>Your ballots</h1>
        </div>
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {orgs.length === 0 ? (
        <NewOrganization onDone={load} first />
      ) : (
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
                      <button key={b.id} className="lobby-item"
                              onClick={() => navigate(`/manage/${b.id}`)}>
                        <span className="lobby-body">
                          <span className="lobby-title">{b.title}</span>
                          <span className="faint" style={{ display: 'block' }}>
                            {b.mode === 'gated' ? 'One question at a time' : 'All questions at once'}
                            {' · '}<span className="mono">/{b.slug}</span>
                          </span>
                        </span>
                        <Pill tone={b.status === 'live' ? 'live' : b.status === 'closed' ? 'defeated' : ''}>
                          {b.status}
                        </Pill>
                      </button>
                    ))}
              </div>

              <NewBallot orgId={org.id} onDone={load} />
            </Card>
          ))}

          <NewOrganization onDone={load} />
        </div>
      )}
    </main>
  );
}

function NewOrganization({ onDone, first = false }: { onDone: () => void; first?: boolean }) {
  const [open, setOpen] = useState(first);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createOrganization({
        name, slug: slug || slugify(name), description: '', contact: '',
      });
      setName(''); setSlug(''); setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create it.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="ghost" onClick={() => setOpen(true)}>+ New organization</button>
    );
  }

  return (
    <Card>
      <h2>{first ? 'Set up your organization' : 'New organization'}</h2>
      <p className="lede">
        Every ballot belongs to an organization. Yours can hold as many as you like.
      </p>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form onSubmit={create} style={{ marginTop: 14 }}>
        <Field label="Name">
          <input required value={name} name="org_name"
                 onChange={(e) => { setName(e.target.value); if (!slug) setSlug(''); }} />
        </Field>
        <Field label="Short name for links" help="Lower case letters, digits and dashes.">
          <input className="mono" name="org_slug"
                 value={slug || slugify(name)} onChange={(e) => setSlug(slugify(e.target.value))} />
        </Field>
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !name}>
            {busy ? 'Creating…' : 'Create organization'}
          </button>
          {!first ? <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button> : null}
        </div>
      </form>
    </Card>
  );
}

function NewBallot({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      setError(err instanceof Error ? err.message : 'Could not create it.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="row" style={{ marginTop: 14 }}>
        <button className="ghost small" onClick={() => setOpen(true)}>+ New ballot</button>
      </div>
    );
  }

  return (
    <form onSubmit={create} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--rule-soft)' }}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <Field label="Ballot title">
        <input required autoFocus value={title} name="ballot_title"
               onChange={(e) => setTitle(e.target.value)}
               placeholder="Annual General Meeting 2026" />
      </Field>
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !title}>
          {busy ? 'Creating…' : 'Create ballot'}
        </button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

export function AdminLinks({ ballot }: { ballot: Ballot }) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return (
    <Card>
      <h3>Links</h3>
      <p className="faint">Give the first to voters. The second is public.</p>
      <Field label="Voting link">
        <input readOnly className="mono" value={`${base}${href(`/vote/${ballot.id}`)}`}
               onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <Field label="Results link">
        <input readOnly className="mono" value={`${base}${href(`/results/${ballot.id}`)}`}
               onFocus={(e) => e.currentTarget.select()} />
      </Field>
    </Card>
  );
}
