/**
 * Option pools: the lists an organizer keeps rather than retypes.
 *
 * The same twelve names go to a meeting three times in an evening -- elect a
 * chair, elect a secretary, elect the committee -- and typing them out again
 * each time is where mistakes come from. A pool is that list, kept once and
 * copied onto a question when it is wanted.
 *
 * A pool belongs to an organization, because that is what the list is of: this
 * society's members. The limit is on the account rather than the organization,
 * so the page counts across all of them and says so.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { parseOptionList } from '../lib/options';
import type { Organization, OptionPool, OptionPoolEntry } from '../lib/types';
import { Banner, Card, Empty, Field, Spinner } from '../components/ui';

export function Pools() {
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [pools, setPools] = useState<OptionPool[]>([]);
  const [cap, setCap] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [mine, all, limits] = await Promise.all([
        api.myOrganizations(), api.myOptionPools(), api.limits(),
      ]);
      setOrgs(mine);
      setPools(all);
      setCap(limits?.option_pools_per_user ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your pools.');
      setOrgs([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (orgs === null) return <main><Spinner label="Loading your option pools" /></main>;

  const full = cap !== null && pools.length >= cap;

  return (
    <main>
      <div className="section-head">
        <div>
          <p className="eyebrow">Option pools</p>
          <h1>Lists you reuse</h1>
          <p className="lede">
            A list of names kept once and copied onto any question that needs it.
            Copying takes a copy — editing a pool afterwards leaves ballots alone.
          </p>
        </div>
        <div className="row-end">
          <span className="quota" data-full={full ? '' : undefined}>
            <span className="quota-note">
              {cap === null
                ? `${pools.length} pool${pools.length === 1 ? '' : 's'}`
                : `${pools.length} of ${cap} pools${full ? ' — delete one to make room' : ''}`}
            </span>
          </span>
        </div>
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {orgs.length === 0 ? (
        <Empty>
          A pool belongs to an organization, and you have none yet. Make one on
          the Organize page first.
        </Empty>
      ) : null}

      <div className="stack">
        {orgs.map((org) => (
          <OrgPools
            key={org.id}
            org={org}
            pools={pools.filter((p) => p.org_id === org.id)}
            full={full}
            onChanged={load}
          />
        ))}
      </div>
    </main>
  );
}

function OrgPools({ org, pools, full, onChanged }: {
  org: Organization; pools: OptionPool[]; full: boolean; onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createOptionPool(org.id, name.trim());
      setName('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make that pool.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="row">
        <div className="grow">
          <h2>{org.name}</h2>
          <p className="faint">
            {pools.length === 0 ? 'No pools on this organization yet.'
              : `${pools.length} pool${pools.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {pools.map((pool) => <Pool key={pool.id} pool={pool} onChanged={onChanged} />)}

      <form onSubmit={create} style={{ marginTop: 14 }}>
        <Field label="New pool"
               help="What the list is — “Members”, “The committee”, “Nominees 2026”.">
          <input name="pool_name" value={name} placeholder="Members"
                 onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" className="ghost"
                disabled={busy || full || name.trim().length === 0}>
          {busy ? 'Making…' : full ? 'No room for another pool' : 'Make this pool'}
        </button>
      </form>
    </Card>
  );
}

/** One pool, and the names in it. */
function Pool({ pool, onChanged }: { pool: OptionPool; onChanged: () => void }) {
  const [entries, setEntries] = useState<OptionPoolEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setEntries(await api.poolEntries(pool.id));
  }, [pool.id]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const parsed = parseOptionList(draft, (entries ?? []).map((e) => e.label));

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.addPoolEntries(pool.id, parsed.labels, (entries?.length ?? 0) + 1);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add those.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const count = entries?.length ?? 0;
    const warn = count > 0
      ? `Delete the pool “${pool.name}” and its ${count} name${count === 1 ? '' : 's'}? `
        + 'Questions you already copied it onto keep their options.'
      : `Delete the pool “${pool.name}”?`;
    if (!confirm(warn)) return;
    await api.deleteOptionPool(pool.id);
    onChanged();
  };

  return (
    <div className="pool">
      <div className="row">
        <button className="ghost small grow" style={{ justifyContent: 'flex-start' }}
                onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {pool.name}
          {entries ? <span className="faint"> · {entries.length}</span> : null}
        </button>
        <button className="danger small" onClick={() => void remove()}>Delete</button>
      </div>

      {!open ? null : entries === null ? <Spinner label="Loading the list" /> : (
        <div style={{ marginTop: 10 }}>
          {error ? <Banner kind="error">{error}</Banner> : null}
          {entries.length === 0 ? <p className="faint">Nothing in this pool yet.</p> : null}

          {entries.map((entry) => (
            <div key={entry.id} className="row" style={{ marginBottom: 8 }}>
              <input className="grow" name="pool_entry" defaultValue={entry.label}
                     onBlur={(e) => {
                       if (e.target.value !== entry.label) {
                         void api.updatePoolEntry(entry.id, { label: e.target.value }).then(load);
                       }
                     }} />
              <button className="danger small"
                      onClick={() => void api.deletePoolEntry(entry.id).then(load)}>
                Remove
              </button>
            </div>
          ))}

          {/* The same parser the question editor uses, so a column pasted out
              of a spreadsheet behaves the same in both places. */}
          <form onSubmit={add} style={{ marginTop: 12 }}>
            <Field label="Add names"
                   help="One per line, or comma separated. Paste a column straight from a spreadsheet.">
              <textarea name="pool_draft" rows={3} value={draft}
                        onChange={(e) => setDraft(e.target.value)} />
            </Field>
            {parsed.labels.length > 0 ? (
              <p className="faint">
                {parsed.labels.length} to add
                {parsed.duplicates.length > 0
                  ? ` · ${parsed.duplicates.length} already in the pool` : ''}
              </p>
            ) : null}
            <button type="submit" className="ghost small"
                    disabled={busy || parsed.labels.length === 0}>
              {busy ? 'Adding…' : 'Add them'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
