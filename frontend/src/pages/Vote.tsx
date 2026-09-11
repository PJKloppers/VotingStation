/**
 * The voter's loop.
 *
 *      PIN ──▶ LOBBY ──(pick a question)──▶ QUESTION ──(submit)──▶ DONE
 *               ▲   │                                                │
 *               └───┴────────────────── reload ◀────────────────────┘
 *
 * In gated mode the lobby shows only the questions whose gate the chair has
 * opened, so the page a voter is staring at changes when the meeting moves on.
 * In open mode every enabled question is listed at once and they work down it
 * at their own pace.
 *
 * Nothing here decides whether a vote is allowed. The rules are re-checked in
 * the database at the moment of the click, and this page renders what it is
 * told -- including, on every submission, the refreshed lobby that came back
 * with the receipt, so the loop closes without a second round trip.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { takePin } from '../lib/handoff';
import { minimumPicks, selectionError, type HighestXConfig } from '../lib/rules';
import { navigate } from '../lib/router';
import type {
  Accepted, Ballot, LobbyQuestion, QuestionResult, Refused, VoterState,
} from '../lib/types';
import { Banner, Card, Empty, Pill, Rail, Spinner } from '../components/ui';
import { QuestionTally } from './Results';

type Screen =
  | { at: 'pin' }
  | { at: 'lobby' }
  | { at: 'question'; question: LobbyQuestion }
  | { at: 'done'; message: string; results: QuestionResult | null };

export function Vote({ ballotId }: { ballotId: string }) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState('');
  const [state, setState] = useState<VoterState | null>(null);
  const [screen, setScreen] = useState<Screen>({ at: 'pin' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.ballotById(ballotId)
      .then((b) => { if (live) { setBallot(b); setLoading(false); } })
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ballotId]);

  /** Applies whatever the server last said about this voter. */
  const apply = useCallback((next: VoterState | Refused): boolean => {
    if (!next.ok) {
      setError(next.error);
      if (!next.closed) setState(null);
      return false;
    }
    setState(next);
    setError('');
    return true;
  }, []);

  const refresh = useCallback(async (thePin = pin) => {
    setBusy(true);
    try {
      const next = await api.voterState(ballotId, thePin);
      const ok = apply(next);
      if (ok) setScreen({ at: 'lobby' });
      else setScreen({ at: 'pin' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, [apply, ballotId, pin]);

  // Optional auto-reload of the waiting screen. Left at 0 for a big meeting:
  // two hundred phones polling every ten seconds is twenty calls a second.
  const every = state?.ballot.lobby_refresh_seconds ?? 0;
  // A voter who entered their PIN on the front page should not be asked for it
  // again. The handoff is in memory only, so a reload lands on the PIN screen.
  useEffect(() => {
    const handed = takePin(ballotId);
    if (!handed) return;
    setPin(handed);
    void refresh(handed);
    // refresh is recreated whenever `pin` changes; running this once, on the
    // ballot, is the whole intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ballotId]);

  useEffect(() => {
    if (screen.at !== 'lobby' || every <= 0) return;
    const id = setInterval(() => { void refresh(); }, every * 1000);
    return () => clearInterval(id);
  }, [screen.at, every, refresh]);

  if (loading) return <main className="narrow"><Spinner label="Opening the ballot" /></main>;

  if (!ballot) {
    return (
      <main className="narrow">
        <Card>
          <h1>Ballot not found</h1>
          <p className="lede">That link does not point at a published ballot.</p>
          <button className="primary" onClick={() => navigate('/')}>Back to the start</button>
        </Card>
      </main>
    );
  }

  return (
    <main className="narrow">
      <div className="stack">
        <header>
          <p className="eyebrow">Ballot</p>
          <h1>{ballot.title}</h1>
          {ballot.description ? <p className="lede">{ballot.description}</p> : null}
        </header>

        {error ? <Banner kind="error">{error}</Banner> : null}

        {screen.at === 'pin' ? (
          <PinScreen
            ballot={ballot}
            pin={pin}
            busy={busy}
            onPin={setPin}
            onSubmit={() => void refresh()}
          />
        ) : null}

        {screen.at === 'lobby' && state ? (
          <Lobby
            state={state}
            busy={busy}
            onReload={() => void refresh()}
            onPick={(q) => { setError(''); setScreen({ at: 'question', question: q }); }}
            onSignOut={() => { setPin(''); setState(null); setScreen({ at: 'pin' }); }}
          />
        ) : null}

        {screen.at === 'question' && state ? (
          <QuestionScreen
            ballotId={ballotId}
            pin={pin}
            question={screen.question}
            allowChange={state.ballot.allow_vote_change}
            onCancel={() => setScreen({ at: 'lobby' })}
            onDone={(accepted) => {
              apply(accepted.state);
              setScreen({ at: 'done', message: accepted.message, results: accepted.results });
            }}
            onRefused={(message) => setError(message)}
          />
        ) : null}

        {screen.at === 'done' ? (
          <Card>
            <p className="eyebrow" style={{ color: 'var(--carried)' }}>Recorded</p>
            <h2>{screen.message}</h2>
            {screen.results ? (
              <div style={{ marginTop: 18 }}><QuestionTally result={screen.results} /></div>
            ) : state?.ballot.show_results_after ? (
              <p className="faint" style={{ marginTop: 12 }}>
                The count appears here once the chair closes this question.
              </p>
            ) : null}
            <div className="row" style={{ marginTop: 18 }}>
              <button className="primary" onClick={() => setScreen({ at: 'lobby' })}>
                Back to the ballot
              </button>
            </div>
          </Card>
        ) : null}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------ the PIN screen */

function PinScreen({ ballot, pin, busy, onPin, onSubmit }: {
  ballot: Ballot; pin: string; busy: boolean;
  onPin: (v: string) => void; onSubmit: () => void;
}) {
  return (
    <Card>
      <p>{ballot.intro_message}</p>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <input
          className="pin-entry"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          aria-label="Your six-digit PIN"
          placeholder="000000"
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button
          type="submit"
          className="primary block"
          style={{ marginTop: 14 }}
          disabled={busy || pin.length !== 6}
        >
          {busy ? 'Checking…' : 'Open my ballot'}
        </button>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------- the lobby */

function Lobby({ state, busy, onReload, onPick, onSignOut }: {
  state: VoterState; busy: boolean;
  onReload: () => void; onPick: (q: LobbyQuestion) => void; onSignOut: () => void;
}) {
  const { progress, questions, ballot } = state;
  const outstanding = questions.filter((q) => !q.voted || ballot.allow_vote_change);

  return (
    <>
      <Card>
        <div className="row">
          <div className="grow">
            <p className="eyebrow">
              Your ballot
              {state.voter.weight > 1 ? ` · ${state.voter.weight} votes` : ''}
            </p>
            <strong>{progress.voted} of {progress.total} answered</strong>
          </div>
          <button className="ghost small" onClick={onSignOut}>Finish</button>
        </div>
        <Rail value={progress.total ? progress.voted / progress.total : 0} />
      </Card>

      {questions.length === 0 ? (
        <Card>
          <Empty>{ballot.waiting_message}</Empty>
          <button className="primary block" onClick={onReload} disabled={busy} style={{ marginTop: 14 }}>
            {busy ? 'Checking…' : 'Reload'}
          </button>
        </Card>
      ) : (
        <Card>
          <h2>{ballot.mode === 'gated' ? 'Open now' : 'Your ballot'}</h2>
          <p className="faint" style={{ marginBottom: 14 }}>
            {outstanding.length === 0
              ? ballot.all_done_message
              : ballot.mode === 'gated'
                ? 'Answer these, then wait for the chair to open the next.'
                : 'Work through these in any order.'}
          </p>

          {questions.map((q) => {
            const settled = q.voted && !ballot.allow_vote_change;
            return (
              <button
                key={q.id}
                className={`lobby-item${q.voted ? ' done' : ''}`}
                disabled={settled}
                onClick={() => onPick(q)}
              >
                <span className="lobby-body">
                  <span className="lobby-title">{q.prompt}</span>
                  {q.description ? <span className="faint" style={{ display: 'block' }}>{q.description}</span> : null}
                </span>
                {q.voted
                  ? <Pill tone="carried">{ballot.allow_vote_change ? 'Change' : 'Voted'}</Pill>
                  : <Pill tone="accent">Vote</Pill>}
              </button>
            );
          })}

          <button className="ghost block" onClick={onReload} disabled={busy} style={{ marginTop: 10 }}>
            {busy ? 'Checking…' : 'Reload'}
          </button>
        </Card>
      )}

      <Settled results={state.settled} />
    </>
  );
}

/**
 * The counts for questions this voter has answered and the chair has since
 * closed. Nothing appears here while a question is still taking votes -- a
 * running tally is exactly what would change the next person's mind.
 */
function Settled({ results }: { results: QuestionResult[] }) {
  if (results.length === 0) return null;
  return (
    <Card>
      <h2>Results</h2>
      <p className="faint" style={{ marginBottom: 14 }}>
        Questions you answered that are now closed.
      </p>
      <div className="stack">
        {results.map((r) => <QuestionTally key={r.id} result={r} />)}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------- one question
 * A branch per question type. Each renders the controls that type needs and
 * calls the cast function whose arguments match it: an enum, one option id,
 * or an array of them.
 */

function QuestionScreen({ ballotId, pin, question, allowChange, onCancel, onDone, onRefused }: {
  ballotId: string; pin: string; question: LobbyQuestion; allowChange: boolean;
  onCancel: () => void; onDone: (a: Accepted) => void; onRefused: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState('');

  const send = async (call: () => Promise<Accepted | Refused>) => {
    setBusy(true); setLocal('');
    try {
      const answer = await call();
      if (answer.ok) onDone(answer);
      else { setLocal(answer.error); onRefused(answer.error); }
    } catch (e) {
      setLocal(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="ghost small" onClick={onCancel}>← Back</button>
        {question.voted ? <Pill tone="carried">Already voted</Pill> : null}
      </div>
      <h2 style={{ marginTop: 8 }}>{question.prompt}</h2>
      {question.description ? <p className="lede">{question.description}</p> : null}
      {question.voted && allowChange
        ? <Banner kind="info">Submitting again replaces your earlier answer.</Banner>
        : null}
      {local ? <Banner kind="error">{local}</Banner> : null}
    </>
  );

  if (question.type === 'yes_no') {
    const cfg = question.config as {
      yes_label: string; no_label: string; allow_abstain: boolean; abstain_label: string;
    };
    const choices: Array<{ value: 'yes' | 'no' | 'abstain'; label: string }> = [
      { value: 'yes', label: cfg.yes_label },
      { value: 'no', label: cfg.no_label },
    ];
    if (cfg.allow_abstain) choices.push({ value: 'abstain', label: cfg.abstain_label });

    return (
      <Card>
        {header}
        <div style={{ marginTop: 16 }}>
          {choices.map((c) => (
            <button
              key={c.value}
              className={`choice${question.previous === c.value ? ' selected' : ''}`}
              disabled={busy}
              onClick={() => void send(() => api.castYesNo(ballotId, pin, question.id, c.value))}
            >
              <span className="tick">✓</span>
              <span className="choice-body">{c.label}</span>
            </button>
          ))}
        </div>
      </Card>
    );
  }

  if (question.type === 'highest_outright') {
    return (
      <OutrightForm
        header={header} busy={busy} question={question}
        onSubmit={(optionId, abstain) =>
          void send(() => api.castHighestOutright(ballotId, pin, question.id, optionId, abstain))}
      />
    );
  }

  return (
    <HighestXForm
      header={header} busy={busy} question={question}
      onSubmit={(ids) => void send(() => api.castHighestX(ballotId, pin, question.id, ids))}
    />
  );
}

function OutrightForm({ header, busy, question, onSubmit }: {
  header: React.ReactNode; busy: boolean; question: LobbyQuestion;
  onSubmit: (optionId: string | null, abstain: boolean) => void;
}) {
  const cfg = question.config as { allow_abstain: boolean; abstain_label: string; require_majority: boolean };
  const previous = typeof question.previous === 'string' ? question.previous : null;
  const [picked, setPicked] = useState<string | null>(previous);

  return (
    <Card>
      {header}
      {cfg.require_majority
        ? <p className="faint">The winner must take more than half of the votes cast.</p>
        : null}
      <div style={{ marginTop: 16 }}>
        {question.options.map((o) => (
          <button
            key={o.id}
            className={`choice${picked === o.id ? ' selected' : ''}`}
            aria-pressed={picked === o.id}
            onClick={() => setPicked(o.id)}
          >
            <span className="tick">✓</span>
            <span className="choice-body">
              {o.label}
              {o.description ? <span className="choice-note">{o.description}</span> : null}
            </span>
          </button>
        ))}
        {cfg.allow_abstain ? (
          <button
            className={`choice${picked === 'abstain' ? ' selected' : ''}`}
            aria-pressed={picked === 'abstain'}
            onClick={() => setPicked('abstain')}
          >
            <span className="tick">✓</span>
            <span className="choice-body">{cfg.abstain_label}</span>
          </button>
        ) : null}
      </div>
      <button
        className="primary block"
        style={{ marginTop: 14 }}
        disabled={busy || picked === null}
        onClick={() => onSubmit(picked === 'abstain' ? null : picked, picked === 'abstain')}
      >
        {busy ? 'Recording…' : 'Submit my vote'}
      </button>
    </Card>
  );
}

function HighestXForm({ header, busy, question, onSubmit }: {
  header: React.ReactNode; busy: boolean; question: LobbyQuestion;
  onSubmit: (ids: string[]) => void;
}) {
  const cfg = question.config as unknown as HighestXConfig;
  const previous = Array.isArray(question.previous) ? question.previous : [];
  const [picked, setPicked] = useState<string[]>(previous);
  const min = minimumPicks(cfg);
  const problem = selectionError(question, picked);

  const toggle = (id: string) => {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      if (current.length >= cfg.select_max) return current;
      return [...current, id];
    });
  };

  return (
    <Card>
      {header}
      <p className="faint">
        Choose {min === cfg.select_max ? `exactly ${min}` : `${min} to ${cfg.select_max}`}
        {' '}· the top {cfg.winner_count} are elected · {picked.length} chosen
      </p>
      <div style={{ marginTop: 12 }}>
        {question.options.map((o) => {
          const on = picked.includes(o.id);
          return (
            <button
              key={o.id}
              className={`choice multi${on ? ' selected' : ''}`}
              aria-pressed={on}
              disabled={!on && picked.length >= cfg.select_max}
              onClick={() => toggle(o.id)}
            >
              <span className="tick">✓</span>
              <span className="choice-body">
                {o.label}
                {o.description ? <span className="choice-note">{o.description}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <button
        className="primary block"
        style={{ marginTop: 14 }}
        disabled={busy || problem !== null}
        onClick={() => onSubmit(picked)}
      >
        {busy ? 'Recording…' : problem ?? 'Submit my vote'}
      </button>
    </Card>
  );
}
