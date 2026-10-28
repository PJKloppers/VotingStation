/**
 * Adding several "Narrow it down" races at once.
 *
 * A church council or a committee election is often a dozen races drawn from
 * a handful of member lists: Chairperson, Secretary, Treasurer… each from the
 * same pool. One row per race asks only what differs between them -- what is
 * being asked, which pool, and whether a majority ends it -- and every other
 * setting takes the race's defaults: anyone may nominate as many as they like,
 * one nomination puts someone through, any number may be picked per round,
 * and the seats are confirmed by the chair after nominations.
 *
 * Races are made one after another, in order, so a failure part-way leaves
 * the ones before it made and says which row stopped.
 */
import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { OptionPool } from '../lib/types';
import { Banner, Modal } from '../components/ui';

import { bulkProblem, RACE_DEFAULTS, type BulkRow as Row } from '../lib/races';

const blank = (pool = ''): Row => ({ prompt: '', pool, majority: true });

export function BulkRaces({ ballotId, after, onAdded }: {
  ballotId: string;
  /** Questions already on the ballot: the new ones go after them. */
  after: number;
  onAdded: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [pools, setPools] = useState<OptionPool[] | null>(null);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!open || pools) return;
    let live = true;
    api.myOptionPools()
      .then((p) => {
        if (!live) return;
        setPools(p);
        // one pool: it is the obvious choice for every row
        if (p.length === 1) setRows((rs) => rs.map((r) => (r.pool ? r : { ...r, pool: p[0]!.id })));
      })
      .catch(() => { if (live) setPools([]); });
    return () => { live = false; };
  }, [open, pools]);

  const set = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  // a new row starts with the pool of the row above: races usually share one
  const addRow = () => setRows((rs) => [...rs, blank(rs[rs.length - 1]?.pool ?? '')]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, k) => k !== i));

  const problem = bulkProblem(rows);

  const close = () => { setOpen(false); setRows([blank()]); setError(''); setPools(null); };

  const add = async () => {
    if (problem) return;
    setBusy(true); setError(''); setDone('');
    let made = 0;
    try {
      for (const [i, r] of rows.entries()) {
        const q = await api.createQuestion('recursion_filter', ballotId, r.prompt.trim(), after + i + 1,
          { ...RACE_DEFAULTS, stop_on_majority: r.majority });
        await api.copyPoolIntoQuestion(r.pool, 'recursion_filter', q.id);
        made++;
      }
      setDone(`${made} race${made === 1 ? '' : 's'} added.`);
      close();
    } catch (e) {
      setError(`Race ${made + 1} ("${rows[made]?.prompt.trim()}") could not be added: ${e instanceof Error ? e.message : 'unknown error'}.`
        + (made > 0 ? ` The ${made} before it ${made === 1 ? 'was' : 'were'} added.` : ''));
      setRows((rs) => rs.slice(made));            // what is left to try again
    } finally {
      setBusy(false);
      if (made > 0) await onAdded();
    }
  };

  return (
    <>
      <div className="row">
        <button className="ghost" onClick={() => { setOpen(true); setDone(''); }}>Bulk add races</button>
        {done ? <span className="faint" role="status">{done}</span> : null}
      </div>

      <Modal open={open} title="Bulk add races" onClose={close}>
        <div className="stack" style={{ gap: 14 }}>
          <p className="faint" style={{ margin: 0 }}>
            One row per race. Each nominates from its pool, with no limit on how many a voter may
            nominate or pick; you confirm the seats after nominations.
          </p>

          {pools && pools.length === 0 ? (
            <Banner kind="info">You have no pools yet. Make one under Pools first: a race draws its people from a pool.</Banner>
          ) : null}

          {rows.map((r, i) => (
            <fieldset key={i} className="card bulk-race" style={{ padding: 12, margin: 0 }}>
              <legend className="faint">Race {i + 1}</legend>
              <label className="field">
                <span>What is being asked?</span>
                <input name="bulk_prompt" value={r.prompt} placeholder="e.g. Choose the Secretary"
                       onChange={(e) => set(i, { prompt: e.target.value })} />
              </label>
              <label className="field">
                <span>Which pool to reuse?</span>
                <select name="bulk_pool" value={r.pool} disabled={!pools || pools.length === 0}
                        onChange={(e) => set(i, { pool: e.target.value })}>
                  <option value="">{pools ? 'Choose a pool…' : 'Loading pools…'}</option>
                  {(pools ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <div className="row">
                <label className="check grow">
                  <input type="checkbox" name="bulk_majority" checked={r.majority}
                         onChange={(e) => set(i, { majority: e.target.checked })} />
                  <span>Stop as soon as someone has a majority</span>
                </label>
                {rows.length > 1 ? (
                  <button className="ghost small" onClick={() => removeRow(i)}>Remove</button>
                ) : null}
              </div>
            </fieldset>
          ))}

          <button className="ghost" onClick={addRow}>Add another race</button>

          {error ? <Banner kind="error">{error}</Banner> : null}

          <div className="row">
            <button className="primary" disabled={busy || problem !== null || !pools}
                    onClick={() => void add()}>
              {busy ? 'Adding…' : `Add ${rows.length} race${rows.length === 1 ? '' : 's'}`}
            </button>
            <button className="ghost" onClick={close}>Cancel</button>
          </div>
          {problem && !busy ? <p className="faint" style={{ margin: 0 }}>{problem}</p> : null}
        </div>
      </Modal>
    </>
  );
}
