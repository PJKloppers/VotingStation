/**
 * The voter's page.
 *
 *      PIN ──▶ every open question, on one page ──▶ exit
 *               ▲                              │
 *               └──────── reload ──────────────┘
 *
 * Each question the chair has opened is answerable where it stands. There used
 * to be a list you tapped into and backed out of, which cost two taps and a
 * page change per answer and hid from a voter how much was in front of them --
 * expensive in a room where the chair is waiting on the slowest phone.
 *
 * In gated mode that is the questions whose gates are open; in open mode it is
 * the whole ballot. Nothing here decides whether a vote is allowed: the rules
 * are re-checked in the database at the moment of the press, and this page
 * renders what it is told -- including the refreshed state that comes back with
 * every receipt, so the page is never a round trip behind the meeting.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { useBallotId, type Address } from '../lib/resolve';
import { minimumPicks, selectionError, type HighestXConfig } from '../lib/rules';
import { navigate } from '../lib/router';
import type {
  Accepted, Ballot, BallotOption, LobbyQuestion, QuestionResult, Refused, VoterState,
} from '../lib/types';
import { Banner, Card, Empty, Pill, Rail, Spinner } from '../components/ui';
import { QuestionTally } from './Results';

export function Vote(address: Address) {
  const { ballotId, pending } = useBallotId(address);
  if (pending) return <main className="narrow"><Spinner label="Finding the ballot" /></main>;
  if (!ballotId) return <NoSuchBallot />;
  return <Ballot ballotId={ballotId} />;
}

function NoSuchBallot() {
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

function Ballot({ ballotId }: { ballotId: string }) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pin, setPin] = useState('');
  const [state, setState] = useState<VoterState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.ballotById(ballotId)
      .then((b) => { if (live) { setBallot(b); setLoading(false); } })
      .catch(() => { if (live) setLoading(false); });
    // The mark is on the organization, not the ballot, so it comes separately --
    // and before a PIN, since it belongs on the very first screen.
    api.ballotLogoPath(ballotId)
      .then((path) => { if (live) setLogo(api.logoUrl(path)); })
      .catch(() => {});
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
      apply(await api.voterState(ballotId, thePin));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, [apply, ballotId, pin]);

  // Optional auto-reload. Left at 0 for a big meeting: two hundred phones
  // polling every ten seconds is twenty calls a second.
  const every = state?.ballot.lobby_refresh_seconds ?? 0;
  useEffect(() => {
    if (!state || every <= 0) return;
    const id = setInterval(() => { void refresh(); }, every * 1000);
    return () => clearInterval(id);
  }, [state, every, refresh]);

  if (loading) return <main className="narrow"><Spinner label="Opening the ballot" /></main>;

  if (!ballot) return <NoSuchBallot />;

  const exit = () => { setPin(''); setState(null); setError(''); };

  return (
    <main className="narrow">
      <div className="stack">
        <header className="ballot-head">
          {logo ? <img className="ballot-mark" src={logo} alt="" /> : null}
          <div>
            <p className="eyebrow">Ballot</p>
            <h1>{ballot.title}</h1>
            {ballot.description ? <p className="lede">{ballot.description}</p> : null}
          </div>
        </header>

        {error ? <Banner kind="error">{error}</Banner> : null}

        {!state ? (
          <PinScreen ballot={ballot} pin={pin} busy={busy}
                     onPin={setPin} onSubmit={() => void refresh()} />
        ) : (
          <Floor
            state={state}
            ballotId={ballotId}
            pin={pin}
            busy={busy}
            onReload={() => void refresh()}
            onAnswered={apply}
            onExit={exit}
          />
        )}
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
          name="pin"
          aria-label="Your six-digit PIN"
          placeholder="000000"
          value={pin}
          onChange={(e) => onPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button type="submit" className="primary block" style={{ marginTop: 14 }}
                disabled={busy || pin.length !== 6}>
          {busy ? 'Checking…' : 'Open my ballot'}
        </button>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------- the floor */

function Floor({ state, ballotId, pin, busy, onReload, onAnswered, onExit }: {
  state: VoterState; ballotId: string; pin: string; busy: boolean;
  onReload: () => void;
  onAnswered: (next: VoterState | Refused) => boolean;
  onExit: () => void;
}) {
  const { progress, questions, ballot } = state;
  const outstanding = questions.filter((q) => !q.voted);

  return (
    <>
      <Card>
        <div className="row">
          <div className="grow">
            <p className="eyebrow">
              Your ballot{state.voter.weight > 1 ? ` · ${state.voter.weight} votes` : ''}
            </p>
            <strong>{progress.voted} of {progress.total} answered</strong>
          </div>
          <button className="ghost small" onClick={onReload} disabled={busy}>
            {busy ? 'Checking…' : 'Reload'}
          </button>
        </div>
        <Rail value={progress.total ? progress.voted / progress.total : 0} />
      </Card>

      {questions.length === 0 ? (
        <Card>
          <Empty>{ballot.waiting_message}</Empty>
          <button className="primary block" onClick={onReload} disabled={busy}
                  style={{ marginTop: 14 }}>
            {busy ? 'Checking…' : 'Reload'}
          </button>
        </Card>
      ) : (
        <>
          <p className="faint">
            {outstanding.length === 0
              ? ballot.all_done_message
              : ballot.mode === 'gated'
                ? `${outstanding.length} open for voting now.`
                : `${outstanding.length} still to answer.`}
          </p>

          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              ballotId={ballotId}
              pin={pin}
              allowChange={ballot.allow_vote_change}
              showResults={ballot.show_results_after}
              gated={ballot.mode === 'gated'}
              alreadyVoted={ballot.already_voted_message}
              onAnswered={onAnswered}
            />
          ))}
        </>
      )}

      <Settled results={state.settled} />

      {/* Large, and at the end, because it is the last thing a voter wants and
          the one thing they should not hit by accident on the way down. */}
      <button className="exit-voting" onClick={onExit}>Exit voting</button>
    </>
  );
}

/* ------------------------------------------------------------- one question */

function QuestionCard({
  question, ballotId, pin, allowChange, showResults, gated, alreadyVoted, onAnswered,
}: {
  question: LobbyQuestion;
  ballotId: string;
  pin: string;
  allowChange: boolean;
  showResults: boolean;
  gated: boolean;
  alreadyVoted: string;
  onAnswered: (next: VoterState | Refused) => boolean;
}) {
  const [chosen, setChosen] = useState<string[]>(() => initial(question));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recorded, setRecorded] = useState(false);

  const settled = question.voted && !allowChange;
  const problem = selectionError(question, chosen);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const answer = await cast(ballotId, pin, question, chosen);
      if (answer.ok) {
        setRecorded(true);
        onAnswered(answer.state);
      } else {
        setError(answer.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="row" style={{ marginBottom: 6 }}>
        <h2 className="grow">{question.prompt}</h2>
        {question.voted
          ? <Pill tone="carried">{allowChange ? 'Answered' : 'Voted'}</Pill>
          : null}
      </div>
      {question.description ? <p className="lede">{question.description}</p> : null}

      {settled ? (
        <p className="faint">{alreadyVoted}</p>
      ) : (
        <>
          {question.voted && allowChange && !recorded
            ? <p className="faint">Submitting again replaces your earlier answer.</p>
            : null}
          {error ? <Banner kind="error">{error}</Banner> : null}
          {recorded && !error ? <Banner kind="good">Your answer is recorded.</Banner> : null}

          <Choices question={question} chosen={chosen}
                   onChange={(next) => { setChosen(next); setRecorded(false); }} />

          <button className="primary block" style={{ marginTop: 12 }}
                  disabled={busy || problem !== null}
                  onClick={() => void submit()}>
            {busy ? 'Recording…' : problem ?? (question.voted ? 'Change my vote' : 'Submit my vote')}
          </button>
        </>
      )}

      {/* Open mode has no gates, so nothing is waiting on a chair there -- it is
          the ballot closing that finishes every question at once. */}
      {showResults ? (
        <p className="faint" style={{ marginTop: 10 }}>
          {gated
            ? 'The count appears below once the chair closes this question.'
            : 'The count appears below once voting closes.'}
        </p>
      ) : null}
    </Card>
  );
}

/** What this voter already has standing, as the controls express it. */
function initial(q: LobbyQuestion): string[] {
  if (q.previous === null) return [];
  return Array.isArray(q.previous) ? q.previous : [q.previous];
}

function cast(
  ballotId: string, pin: string, q: LobbyQuestion, chosen: string[],
): Promise<Accepted | Refused> {
  if (q.type === 'yes_no') {
    return api.castYesNo(ballotId, pin, q.id, chosen[0] as 'yes' | 'no' | 'abstain');
  }
  if (q.type === 'highest_outright') {
    const one = chosen[0] ?? null;
    return api.castHighestOutright(ballotId, pin, q.id,
      one === 'abstain' ? null : one, one === 'abstain');
  }
  return api.castHighestX(ballotId, pin, q.id, chosen);
}

/* -------------------------------------------------------------- the controls
 * One branch per question type, because one table per type is the design. */

function Choices({ question, chosen, onChange }: {
  question: LobbyQuestion; chosen: string[]; onChange: (next: string[]) => void;
}) {
  if (question.type === 'yes_no') {
    const cfg = question.config as {
      yes_label: string; no_label: string; allow_abstain: boolean; abstain_label: string;
    };
    const options = [
      { value: 'yes', label: cfg.yes_label },
      { value: 'no', label: cfg.no_label },
      ...(cfg.allow_abstain ? [{ value: 'abstain', label: cfg.abstain_label }] : []),
    ];
    return (
      <div style={{ marginTop: 12 }}>
        {options.map((o) => (
          <Choice key={o.value} label={o.label}
                  selected={chosen[0] === o.value}
                  onClick={() => onChange([o.value])} />
        ))}
      </div>
    );
  }

  if (question.type === 'highest_outright') {
    const cfg = question.config as {
      allow_abstain: boolean; abstain_label: string; require_majority: boolean;
    };
    return (
      <>
        {cfg.require_majority
          ? <p className="faint">The winner must take more than half of the votes cast.</p>
          : null}
        <div style={{ marginTop: 12 }}>
          {question.options.map((o: BallotOption) => (
            <Choice key={o.id} label={o.label} note={o.description}
                    selected={chosen[0] === o.id}
                    onClick={() => onChange([o.id])} />
          ))}
          {cfg.allow_abstain ? (
            <Choice label={cfg.abstain_label}
                    selected={chosen[0] === 'abstain'}
                    onClick={() => onChange(['abstain'])} />
          ) : null}
        </div>
      </>
    );
  }

  const cfg = question.config as unknown as HighestXConfig;
  const min = minimumPicks(cfg);
  const toggle = (id: string) => {
    if (chosen.includes(id)) onChange(chosen.filter((x) => x !== id));
    else if (chosen.length < cfg.select_max) onChange([...chosen, id]);
  };

  return (
    <>
      <p className="faint">
        Choose {min === cfg.select_max ? `exactly ${min}` : `${min} to ${cfg.select_max}`}
        {' '}· the top {cfg.winner_count} are elected · {chosen.length} chosen
      </p>
      <div style={{ marginTop: 8 }}>
        {question.options.map((o: BallotOption) => (
          <Choice key={o.id} label={o.label} note={o.description} multi
                  selected={chosen.includes(o.id)}
                  disabled={!chosen.includes(o.id) && chosen.length >= cfg.select_max}
                  onClick={() => toggle(o.id)} />
        ))}
      </div>
    </>
  );
}

function Choice({ label, note, selected, multi = false, disabled = false, onClick }: {
  label: string; note?: string; selected: boolean;
  multi?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`choice${multi ? ' multi' : ''}${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="tick">✓</span>
      <span className="choice-body">
        {label}
        {note ? <span className="choice-note">{note}</span> : null}
      </span>
    </button>
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
