/**
 * One ballot, from the organizer's side.
 *
 * The Live tab is the meeting itself: one row per question, an Open gate
 * button, and the running count beside it. Everything else is preparation.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { AnyQuestion } from '../lib/api';
import { href, navigate } from '../lib/router';
import type { Ballot, BallotResults, QuestionResult } from '../lib/types';
import { Banner, Card, Check, Empty, Field, Pill, Rail, Spinner } from '../components/ui';
import { AdminLinks } from './Admin';
import { Questions } from './Questions';
import { Results } from './Results';
import { Tokens } from './Tokens';

const TABS = ['Live', 'Questions', 'PINs', 'Settings', 'Results', 'Links'] as const;
type Tab = (typeof TABS)[number];

export function Manage({ ballotId }: { ballotId: string }) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [tab, setTab] = useState<Tab>('Live');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const b = await api.ballotById(ballotId);
      if (!b) setError('That ballot is not yours, or no longer exists.');
      setBallot(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the ballot.');
    }
  }, [ballotId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <main><Banner kind="error">{error}</Banner></main>;
  if (!ballot) return <main><Spinner label="Loading the ballot" /></main>;

  const setStatus = async (status: Ballot['status']) => {
    await api.updateBallot(ballot.id, { status });
    await load();
  };

  return (
    <main>
      <div className="section-head">
        <div>
          <button className="ghost small" onClick={() => navigate('/admin')}>← All ballots</button>
          <h1 style={{ marginTop: 8 }}>{ballot.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <Pill tone={ballot.status === 'live' ? 'live' : ballot.status === 'closed' ? 'defeated' : ''}>
              {ballot.status}
            </Pill>
            <span className="faint">
              {ballot.mode === 'gated' ? 'One question at a time' : 'All questions at once'}
              {ballot.anonymous ? ' · anonymous' : ' · named'}
            </span>
            <Expiry ballot={ballot} onRenewed={load} />
          </div>
        </div>
        <div className="row-end row">
          <a className="btn btn-ghost" href={href(`/live/${ballot.id}`)}>Live results</a>
          {ballot.status !== 'live'
            ? <button className="primary" onClick={() => void setStatus('live')}>Publish</button>
            : <button className="ghost" onClick={() => void setStatus('closed')}>Close voting</button>}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === 'Live' ? <Live ballot={ballot} onFinished={load} /> : null}
      {tab === 'Questions' ? <Questions ballotId={ballot.id} /> : null}
      {tab === 'PINs' ? <Tokens ballotId={ballot.id} /> : null}
      {tab === 'Settings' ? <Settings ballot={ballot} onSaved={load} /> : null}
      {tab === 'Results' ? <Results ballotId={ballot.id} /> : null}
      {tab === 'Links' ? <AdminLinks ballot={ballot} /> : null}
    </main>
  );
}

/**
 * The clock a ballot is on.
 *
 * Every ballot is deleted thirty days after it is made, so the one thing that
 * must not be quiet about it is the ballot's own page. Renewing pushes the full
 * window out again from now.
 */
function Expiry({ ballot, onRenewed }: { ballot: Ballot; onRenewed: () => void }) {
  const [busy, setBusy] = useState(false);
  const { text, urgent } = untilExpiry(ballot.expires_at);

  const renew = async () => {
    setBusy(true);
    try { await api.renewBallot(ballot.id); onRenewed(); }
    finally { setBusy(false); }
  };

  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="faint" style={urgent ? { color: 'var(--defeated)' } : undefined}>
        · {text}
      </span>
      <button className="ghost small" disabled={busy} onClick={() => void renew()}>
        {busy ? 'Renewing…' : 'Renew'}
      </button>
    </span>
  );
}

/* ------------------------------------------------------------ the meeting */

function Live({ ballot, onFinished }: { ballot: Ballot; onFinished: () => void }) {
  const [questions, setQuestions] = useState<AnyQuestion[] | null>(null);
  const [results, setResults] = useState<BallotResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [qs, res] = await Promise.all([
        api.questionsForBallot(ballot.id),
        api.ballotResults(ballot.id),
      ]);
      setQuestions(qs);
      setResults(res.ok ? res : null);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh.');
    }
  }, [ballot.id]);

  useEffect(() => { void load(); }, [load]);

  // The chair's page is one screen, refreshed on a slow beat.
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(id);
  }, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  };

  if (questions === null) return <Spinner label="Reading the ballot" />;
  const enabled = questions.filter((q) => q.enabled);

  const step = async () => {
    setBusy(true);
    try {
      const answer = await api.advanceBallot(ballot.id);
      if (!answer.ok) setError(answer.error ?? 'That did not work.');
      await load();
      if (answer.action === 'finished') onFinished();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}
      {ballot.status !== 'live'
        ? <Banner kind="info">
            This ballot is {ballot.status}. Voters cannot reach it until you publish it.
          </Banner>
        : null}
      {ballot.mode === 'open'
        ? <Banner kind="info">
            In open mode every enabled question is on the voter's page at once, so the
            gates below do not apply.
          </Banner>
        : null}

      {ballot.mode === 'gated' && ballot.status === 'live' ? (
        <Card>
          <div className="row">
            <div className="grow">
              <p className="eyebrow">The floor</p>
              <strong>{stepLabel(enabled, results)}</strong>
            </div>
            <button className="primary" disabled={busy || enabled.length === 0}
                    onClick={() => void step()}>
              {busy ? 'Working…' : stepButton(enabled)}
            </button>
          </div>
        </Card>
      ) : null}

      <div className="row">
        <span className="faint grow">
          {results ? `${results.turnout.used} of ${results.turnout.issued} PINs used` : ''}
        </span>
        <button className="ghost small" onClick={() => void load()}>Refresh</button>
        <button className="ghost small" disabled={busy}
                onClick={() => void act(() => api.closeAllGates(ballot.id))}>
          Close all gates
        </button>
      </div>

      {enabled.length === 0 ? <Empty>No questions on the ballot yet.</Empty> : null}

      {enabled.map((q) => {
        const tally = results?.questions.find((r) => r.id === q.id);
        return (
          <Card key={q.id}>
            <div className="row">
              <div className="grow">
                <h3>{q.prompt}</h3>
                <p className="faint">{leadLine(tally)}</p>
              </div>
              {q.gate_open ? <Pill tone="open">Open</Pill> : <Pill tone="closed">Closed</Pill>}
            </div>

            <Turnout
              voted={tally ? votersOn(tally) : 0}
              eligible={results?.turnout.eligible ?? 0}
              required={ballot.require_all_pins}
            />
            <div className="row" style={{ marginTop: 14 }}>
              {q.gate_open ? (
                <button className="ghost" disabled={busy}
                        onClick={() => void act(() => api.setGate(ballot.id, q.type, q.id, false))}>
                  Close gate
                </button>
              ) : (
                <>
                  <button className="primary" disabled={busy}
                          onClick={() => void act(() => api.setGate(ballot.id, q.type, q.id, true))}>
                    Open gate
                  </button>
                  <button className="ghost" disabled={busy}
                          onClick={() => void act(() => api.setGate(ballot.id, q.type, q.id, true, true))}>
                    Open only this
                  </button>
                </>
              )}
              <a className="btn btn-ghost small row-end" href={href(`/results/${ballot.id}`)}>
                Public results
              </a>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * How much of the room has answered one question.
 *
 * The chair's question is always "can I move on yet", so the card answers it
 * before they have to ask. When the ballot waits for everyone, the same bar is
 * also the thing standing between them and the next question, so it says so.
 */
function Turnout({ voted, eligible, required }: {
  voted: number; eligible: number; required: boolean;
}) {
  if (eligible === 0) return null;
  const all = voted >= eligible;

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, marginBottom: 2 }}>
        <span className="faint grow">{voted} of {eligible} PINs voted</span>
        {required
          ? all
            ? <Pill tone="carried">All in</Pill>
            : <Pill tone="pending">Waiting for {eligible - voted}</Pill>
          : null}
      </div>
      <Rail value={voted / eligible} />
    </div>
  );
}

/**
 * What the step button is about to do, in full. A chair pressing this in front
 * of a room should not have to guess which question it moves to.
 */
function nextInLine(enabled: AnyQuestion[]): { open: AnyQuestion | null; next: AnyQuestion | null } {
  const open = enabled.find((q) => q.gate_open) ?? null;
  if (!open) return { open: null, next: enabled[0] ?? null };
  const at = enabled.indexOf(open);
  return { open, next: enabled[at + 1] ?? null };
}

function stepLabel(enabled: AnyQuestion[], results: BallotResults | null): string {
  const { open, next } = nextInLine(enabled);
  if (enabled.length === 0) return 'No questions on the ballot yet.';
  if (!open) return `Nothing is open. Next up: "${next?.prompt ?? '—'}".`;
  const voted = results?.questions.find((r) => r.id === open.id);
  const count = voted ? ` · ${votersOn(voted)} voted so far` : '';
  return next
    ? `Open: "${open.prompt}"${count}. Next: "${next.prompt}".`
    : `Open: "${open.prompt}"${count}. This is the last question.`;
}

function stepButton(enabled: AnyQuestion[]): string {
  const { open, next } = nextInLine(enabled);
  if (!open) return 'Open the first question';
  return next ? 'Close and open the next' : 'Close and end the ballot';
}

function votersOn(result: QuestionResult): number {
  return result.type === 'yes_no' ? result.tally.voters : result.tally.voters;
}

/** The one line of the tally that a chairperson actually watches. */
function leadLine(result: QuestionResult | undefined): string {
  if (!result) return 'No count yet';
  if (result.type === 'yes_no') {
    const t = result.tally;
    if (t.cast === 0) return 'No votes yet';
    return `${t.voters} voted · ${t.yes} ${t.labels.yes} / ${t.no} ${t.labels.no}`;
  }
  const t = result.tally;
  if (t.voters === 0) return 'No votes yet';
  const leader = t.options[0];
  return `${t.voters} voted · leading: ${leader ? `${leader.label} (${leader.votes})` : '—'}`;
}

/* ----------------------------------------------------------- the settings */

function Settings({ ballot, onSaved }: { ballot: Ballot; onSaved: () => void }) {
  const [draft, setDraft] = useState<Partial<Ballot>>({});
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
  // Typing the title out is the confirmation. An irreversible thing should cost
  // more than the reflex that dismisses a dialog.
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const v = <K extends keyof Ballot>(key: K): Ballot[K] =>
    (key in draft ? draft[key] : ballot[key]) as Ballot[K];
  const set = <K extends keyof Ballot>(key: K, value: Ballot[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.updateBallot(ballot.id, draft);
      setDraft({}); setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setError('');
    try {
      await api.deleteBallot(ballot.id);
      navigate('/admin');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the ballot.');
    }
  };

  const voidVotes = async () => {
    if (!confirm(`Void every vote on "${ballot.title}"? The questions and PINs stay.`)) return;
    setVoiding(true); setError('');
    try {
      await api.clearBallotVotes(ballot.id);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not void the votes.');
    } finally {
      setVoiding(false);
    }
  };

  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}
      {saved ? <Banner kind="good">Saved.</Banner> : null}

      <Card>
        <h3>The ballot</h3>
        <Field label="Title">
          <input value={v('title')} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea value={v('description')} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <Field label="Short name for links">
          <input className="mono" value={v('slug')} onChange={(e) => set('slug', e.target.value)} />
        </Field>
        <Field label="Mode" help="Gated runs a live meeting one question at a time. Open puts the whole ballot on one page.">
          <select value={v('mode')} onChange={(e) => set('mode', e.target.value as Ballot['mode'])}>
            <option value="gated">Gated — one question at a time</option>
            <option value="open">Open — the whole ballot at once</option>
          </select>
        </Field>
      </Card>

      <Card>
        <h3>Schedule</h3>
        <p className="faint">Optional, and on top of the publish switch.</p>
        <div className="row">
          <div className="grow">
            <Field label="Opens at">
              <input type="datetime-local" value={toLocal(v('opens_at'))}
                     onChange={(e) => set('opens_at', fromLocal(e.target.value))} />
            </Field>
          </div>
          <div className="grow">
            <Field label="Closes at">
              <input type="datetime-local" value={toLocal(v('closes_at'))}
                     onChange={(e) => set('closes_at', fromLocal(e.target.value))} />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <h3>Ballot rules</h3>
        <Check label="Allow changing a vote" checked={v('allow_vote_change')}
               onChange={(x) => set('allow_vote_change', x)}
               help="A voter may reopen a question while its gate is open. The earlier ballot is superseded, never deleted." />
        <Check label="Anonymous ballots" checked={v('anonymous')}
               onChange={(x) => set('anonymous', x)}
               help="Store a salted hash instead of the PIN. Cannot be changed once a vote has been cast." />
        <Check label="All questions required (open mode)" checked={v('require_all')}
               onChange={(x) => set('require_all', x)} />
        <Check label="All PINs must vote" checked={v('require_all_pins')}
               onChange={(x) => set('require_all_pins', x)}
               help="Gated mode: the step button will not close a question until every active PIN has answered it. A disabled PIN is not waited for." />
        <Check label="Show the result after voting" checked={v('show_results_after')}
               onChange={(x) => set('show_results_after', x)} />
        <Check label="Publish the results once voting closes" checked={v('results_public')}
               onChange={(x) => set('results_public', x)}
               help="While the ballot is live the tally is yours alone either way. Off keeps it private after it closes too." />
        <Field label="Auto-reload the waiting screen"
               help="Seconds. Leave at 0 for a large meeting — two hundred phones polling every ten seconds is twenty calls a second.">
          <input type="number" min={0} max={3600} value={v('lobby_refresh_seconds')}
                 onChange={(e) => set('lobby_refresh_seconds', Number(e.target.value))} />
        </Field>
      </Card>

      <Card>
        <h3>What voters read</h3>
        {([
          ['intro_message', 'On the PIN screen'],
          ['waiting_message', 'While waiting for a gate'],
          ['all_done_message', 'When everything is answered'],
          ['thank_you_message', 'After a vote is recorded'],
          ['already_voted_message', 'On a question already answered'],
          ['closed_message', 'When voting is closed'],
        ] as const).map(([key, label]) => (
          <Field key={key} label={label}>
            <textarea value={v(key)} onChange={(e) => set(key, e.target.value)} style={{ minHeight: 60 }} />
          </Field>
        ))}
      </Card>

      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button className="ghost" disabled={!dirty} onClick={() => { setDraft({}); setSaved(false); }}>
          Discard
        </button>
      </div>

      {/* Two irreversible things, and one of them is much worse than the other.
          Each says what it takes and what it leaves, because "Void every vote"
          and "Delete this ballot" read almost the same on a button. */}
      <section className="danger-zone">
        <h3>Danger</h3>

        <div className="danger-row">
          <div className="grow">
            <strong>Void every vote</strong>
            <p className="faint">
              Marks every ballot cast as superseded and returns each PIN to unused.
              The questions, the options and the PINs themselves stay, and the rows
              are not deleted &mdash; the log still reads. Use it to rerun a vote.
            </p>
          </div>
          <button className="btn-danger" disabled={voiding} onClick={() => void voidVotes()}>
            {voiding ? 'Voiding\u2026' : 'Void votes'}
          </button>
        </div>

        <div className="danger-row">
          <div className="grow">
            <strong>Delete this ballot</strong>
            <p className="faint">
              Removes &ldquo;{ballot.title}&rdquo; along with its questions, its options,
              its PINs and every vote ever cast on it. There is no undo.
            </p>

            {confirming ? (
              <div className="danger-confirm">
                <label className="field" style={{ margin: 0 }}>
                  <span className="label">Type the title to confirm</span>
                  <input
                    name="confirm_title"
                    autoFocus
                    autoComplete="off"
                    placeholder={ballot.title}
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </div>

          {confirming ? (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <button className="ghost"
                      onClick={() => { setConfirming(false); setTyped(''); }}>
                Cancel
              </button>
              <button className="btn-danger solid"
                      disabled={typed.trim() !== ballot.title.trim()}
                      onClick={() => void remove()}>
                Delete for good
              </button>
            </div>
          ) : (
            <button className="btn-danger solid" onClick={() => setConfirming(true)}>
              Delete ballot
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

/** How long a ballot has left, in the words a person would use. */
export function untilExpiry(iso: string): { text: string; urgent: boolean } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: 'expired', urgent: true };
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return { text: `purges in ${days} days`, urgent: days <= 3 };
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 2) return { text: `purges in ${hours} hours`, urgent: true };
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return { text: `purges in ${minutes} min`, urgent: true };
}

function toLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocal(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}
