/**
 * The chair's controls for one recursion filter, on the Live tab.
 *
 * Made to be run in front of a room, so the panel shows one thing to do at a
 * time: a single main button that moves the race on.
 *
 *   not opened  → Open nominations / Open round N
 *   open        → Close nominations / Close round N
 *   closed      → Settle… (a round asks how people drop out first)
 *   settled     → the next round, not opened yet, and round again
 *
 * Settling an elimination round opens a short dialog with the round's counts
 * and the one question the chair must answer every round: how do people drop
 * out? Everyone on X votes or fewer, the lowest N, or nobody. The preview
 * shows who would be elected and who would drop before anything is decided.
 * A tie on the last seat or at the cut is answered in the same dialog.
 *
 * Everything else (adding from the pool, withdrawing someone, choosing the
 * shortlist by hand, ending the vote) is under "More controls", out of the
 * way until it is wanted.
 *
 * Every button here is a request. The database checks it again and answers in
 * a sentence when it will not do it, which is shown as it comes.
 */
import { useMemo, useState } from 'react';
import * as api from '../lib/api';
import type { RoundAnswer } from '../lib/api';
import { previewDrop } from '../lib/rules';
import type { DropRule, RecursionTally } from '../lib/types';
import { Banner, Modal, Pill } from '../components/ui';
import { RecursionResult } from '../components/RecursionResult';

type Said = { kind: 'info' | 'error' | 'good'; text: string } | null;

export function RecursionControls({ ballotId, questionId, tally, busy, act }: {
  ballotId: string;
  questionId: string;
  tally: RecursionTally;
  busy: boolean;
  /** Runs a call, then reloads the Live tab. */
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [said, setSaid] = useState<Said>(null);
  const [settling, setSettling] = useState(false);

  const seats = tally.seats ?? 1;
  const committee = seats > 1;
  const round = tally.rounds[tally.rounds.length - 1];
  const current = round?.tally;
  const decided = tally.phase === 'decided';
  const nominating = tally.phase === 'nominating';
  const open = current?.gate_open ?? false;
  const opened = current?.opened ?? false;
  const inRace = tally.candidates.filter((c) => c.status === 'in');
  const elected = tally.elected ?? (tally.winner ? [{ ...tally.winner, round: null, seat: 1 }] : []);
  const seatsOpen = current?.seats_open ?? seats;
  const thisRound = current?.options.length ?? 0;
  const name = nominating ? 'nominations' : `round ${tally.current_round}`;
  const Name = nominating ? 'Nominations' : `Round ${tally.current_round}`;
  // a round with no more people than seats is not voted on: settling elects them all
  const nothingToVote = !nominating && !opened && inRace.length <= seatsOpen;

  /** Calls the database, and says what it answered. */
  const call = (fn: () => Promise<RoundAnswer>, onOk?: (a: RoundAnswer) => void) =>
    act(async () => {
      const answer = await fn();
      if (answer.ok) {
        setSaid(answer.message ? { kind: 'good', text: answer.message } : null);
        onOk?.(answer);
      } else {
        setSaid({ kind: 'error', text: answer.error ?? 'That did not work.' });
      }
    });

  /** Opens or closes the current round's gate. */
  const gate = (to: boolean) =>
    act(async () => {
      await api.setGate(ballotId, 'recursion_filter', questionId, to);
      setSaid(to
        ? { kind: 'good', text: `${Name} ${nominating ? 'are' : 'is'} open. Voters can see it now.` }
        : { kind: 'info', text: `${Name} ${nominating ? 'are' : 'is'} closed. Settle ${nominating ? 'them' : 'it'} to go on.` });
    });

  return (
    <div style={{ marginTop: 14 }}>
      <Stages tally={tally} />

      {committee ? (
        <p style={{ margin: '10px 0 0' }}>
          <strong>{elected.length} of {seats} seats filled</strong>
          {elected.length > 0
            ? <span className="faint"> · {elected.map((e) => e.label).join(', ')}</span>
            : null}
        </p>
      ) : null}

      {decided ? null : (
        <div className="card" style={{ padding: 14, marginTop: 10 }}>
          <div className="row">
            <strong className="grow">
              {Name}
              {committee && !nominating ? <span className="faint"> · {seatsOpen} seat{seatsOpen === 1 ? '' : 's'} open</span> : null}
            </strong>
            {open ? <Pill tone="open">Voting</Pill>
              : opened ? <Pill tone="pending">Closed — settle it</Pill>
              : <Pill tone="closed">Not opened yet</Pill>}
          </div>

          <p className="faint" style={{ margin: '6px 0 10px' }}>
            {nothingToVote
              ? `Only ${inRace.length} left for ${seatsOpen} seat${seatsOpen === 1 ? '' : 's'}: there is nothing to vote on. Elect them, or add someone from the pool first.`
              : !opened && !open
                ? nominating
                  ? 'Open nominations to let voters name people from the pool.'
                  : `${thisRound} in this round. ${committee ? `Each voter can choose up to ${current?.pick_max ?? seatsOpen}.` : 'Open it to let voters choose.'}`
                : open
                  ? `${current?.voters ?? 0} voted so far. Close ${name} when the room is done.`
                  : nominating
                    ? `Settling puts everyone with ${tally.nominate_threshold} or more nomination${tally.nominate_threshold === 1 ? '' : 's'} through to round 1.`
                    : 'Settle the round: you will be asked how people drop out.'}
          </p>

          {nothingToVote ? (
            <button className="primary" disabled={busy}
                    onClick={() => void call(() => api.settleRound(questionId))}>
              Elect all {inRace.length}
            </button>
          ) : !opened && !open ? (
            <button className="primary" disabled={busy} onClick={() => void gate(true)}>
              Open {name}
            </button>
          ) : open ? (
            <button className="primary" disabled={busy} onClick={() => void gate(false)}>
              Close {name}
            </button>
          ) : (
            <div className="row">
              <button className="primary" disabled={busy}
                      onClick={() => nominating
                        ? void call(() => api.settleRound(questionId))
                        : setSettling(true)}>
                {nominating ? 'Settle nominations' : `Settle ${name}…`}
              </button>
              <button className="ghost" disabled={busy} onClick={() => void gate(true)}>
                Reopen
              </button>
            </div>
          )}
        </div>
      )}

      {said ? <div style={{ marginTop: 12 }}><Banner kind={said.kind}>{said.text}</Banner></div> : null}

      {decided ? null : (
        <More tally={tally} questionId={questionId} busy={busy} call={call} />
      )}

      {settling && current ? (
        <SettleDialog
          key={tally.current_round}
          tally={tally}
          questionId={questionId}
          busy={busy}
          act={act}
          onDone={(text) => { setSettling(false); setSaid(text ? { kind: 'good', text } : null); }}
          onClose={() => setSettling(false)}
        />
      ) : null}

      {/* The count comes after the controls: a pool of thirty-odd names
          would otherwise push every button off the screen. */}
      <div style={{ marginTop: 18 }}>
        <RecursionResult tally={tally} chair />
      </div>
    </div>
  );
}

/* ------------------------------------------------------- the settle dialog */

/**
 * Settling a round: how do people drop out, with a live preview, and any tie
 * the chair has to break. Nothing is decided until "Settle".
 */
function SettleDialog({ tally, questionId, busy, act, onDone, onClose }: {
  tally: RecursionTally;
  questionId: string;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<void>;
  onDone: (message: string | null) => void;
  onClose: () => void;
}) {
  const rounds = tally.rounds;
  const round = rounds[rounds.length - 1]!;
  const t = round.tally;
  const before = rounds.length > 1 ? rounds[rounds.length - 2] : undefined;
  const seats = tally.seats ?? 1;

  // prefilled: this round's rule if already set, else the round before's
  const startRule: DropRule = t.drop_rule ?? before?.drop_rule ?? 'votes';
  const startN = startRule === 'count' ? t.drop_count ?? before?.drop_count ?? null
    : startRule === 'votes' ? t.drop_votes ?? before?.drop_votes ?? null : null;
  const [rule, setRule] = useState<DropRule>(startRule);
  const [n, setN] = useState<string>(startN === null ? '' : String(startN));
  const [seatPick, setSeatPick] = useState<string[]>([]);
  const [cutPick, setCutPick] = useState<string[]>([]);
  const [error, setError] = useState('');

  const inRace = tally.candidates.filter((c) => c.status === 'in').length;
  const num = n === '' ? null : Number(n);
  const preview = useMemo(() => previewDrop(t, inRace, rule, num), [t, inRace, rule, num]);
  const seatTieK = t.seat_tie_count ?? 0;
  const seatTied = t.options.filter((o) => o.seat_tied);
  const label = (id: string) => t.options.find((o) => o.id === id)?.label ?? '';
  const electing = [...(t.elect ?? []), ...seatPick];

  const ready = (seatTieK === 0 || seatPick.length === seatTieK)
    && (preview.fills || rule === 'none' || (num !== null && preview.error === null))
    && (preview.tieK === 0 || cutPick.length === preview.tieK);

  const toggle = (list: string[], id: string, max: number) =>
    list.includes(id) ? list.filter((x) => x !== id)
      : list.length < max ? [...list, id] : list;

  const settle = () => act(async () => {
    setError('');
    if (!preview.fills) {
      const set = await api.setRoundDrop(questionId, rule, num);
      if (!set.ok) { setError(set.error ?? 'That rule cannot be used.'); return; }
    }
    const answer = await api.settleRound(questionId,
      cutPick.length ? cutPick : undefined, undefined, seatPick.length ? seatPick : undefined);
    if (answer.ok) onDone(answer.message ?? null);
    else setError(answer.error ?? 'That did not work.');
  });

  return (
    <Modal open title={`Settle round ${round.round}`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        {/* the counts, marked with what settling would do */}
        <div aria-label="This round's count">
          {t.options.map((o) => {
            const mark = electing.includes(o.id) ? 'elected'
              : o.seat_tied ? 'tied for the last seat'
              : preview.drop.includes(o.id) || cutPick.includes(o.id) ? 'drops'
              : preview.tied.includes(o.id) ? 'tied at the cut' : '';
            return (
              <div key={o.id} className={`result-bar ${mark === 'elected' ? 'won' : mark === 'drops' ? 'lost' : ''}`}>
                <span className="label">{o.label}{mark ? ` — ${mark}` : ''}</span>
                <span className="count">{o.votes}</span>
                <span className="track"><i style={{ width: `${Math.max(o.share * 100, o.votes > 0 ? 2 : 0)}%` }} /></span>
              </div>
            );
          })}
          <p className="faint" style={{ marginTop: 6 }}>
            {t.voters} voted{t.ballots > 0 ? ` · a majority is more than ${Math.floor(t.ballots / 2)}` : ''}
          </p>
        </div>

        {/* a tie on the last seat */}
        {seatTieK > 0 ? (
          <div className="card" style={{ padding: 14 }}>
            <strong>Choose {seatTieK} to elect</strong>
            <p className="faint">More people have a majority than there are seats, and the last {seatTieK === 1 ? 'seat falls' : `${seatTieK} seats fall`} on a tie.</p>
            {seatTied.map((o) => (
              <label key={o.id} className="check">
                <input type="checkbox" name="seat_tie" checked={seatPick.includes(o.id)}
                       onChange={() => setSeatPick(toggle(seatPick, o.id, seatTieK))} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        ) : null}

        {preview.fills ? (
          <Banner kind="info">
            {seats > 1
              ? `This round fills the ${preview.seatsAfter === 0 ? 'last seats' : `last ${preview.seatsAfter} seat${preview.seatsAfter === 1 ? '' : 's'} with everyone left`}. Nobody needs to drop.`
              : 'This round decides the winner. Nobody needs to drop.'}
          </Banner>
        ) : (
          <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
            <legend><strong>How do people drop out of round {round.round}?</strong></legend>
            <label className="check">
              <input type="radio" name="drop_rule" value="votes" checked={rule === 'votes'}
                     onChange={() => setRule('votes')} />
              <span>Everyone with{' '}
                <input type="number" min={0} name="drop_votes" style={{ width: 70 }}
                       value={rule === 'votes' ? n : ''} onFocus={() => setRule('votes')}
                       onChange={(e) => { setRule('votes'); setN(e.target.value); }} />
                {' '}votes or fewer</span>
            </label>
            <label className="check">
              <input type="radio" name="drop_rule" value="count" checked={rule === 'count'}
                     onChange={() => setRule('count')} />
              <span>The lowest{' '}
                <input type="number" min={0} name="drop_count" style={{ width: 70 }}
                       value={rule === 'count' ? n : ''} onFocus={() => setRule('count')}
                       onChange={(e) => { setRule('count'); setN(e.target.value); }} />
                {' '}people</span>
            </label>
            <label className="check">
              <input type="radio" name="drop_rule" value="none" checked={rule === 'none'}
                     onChange={() => setRule('none')} />
              <span>Nobody drops this round</span>
            </label>

            <p className={preview.error ? 'error-text' : 'faint'} aria-live="polite" style={{ margin: 0 }}>
              {preview.error
                ?? (rule !== 'none' && num === null
                  ? 'Give a number.'
                  : `${preview.drop.length + preview.tieK} drop · ${preview.left} stay for ${preview.seatsAfter} seat${preview.seatsAfter === 1 ? '' : 's'}`)}
            </p>
          </fieldset>
        )}

        {/* a tie at the cut */}
        {!preview.fills && preview.tieK > 0 ? (
          <div className="card" style={{ padding: 14 }}>
            <strong>Choose {preview.tieK} to drop</strong>
            <p className="faint">They are tied at the cut.</p>
            {preview.tied.map((id) => (
              <label key={id} className="check">
                <input type="checkbox" name="cut_tie" checked={cutPick.includes(id)}
                       onChange={() => setCutPick(toggle(cutPick, id, preview.tieK))} />
                <span>{label(id)}</span>
              </label>
            ))}
          </div>
        ) : null}

        {error ? <Banner kind="error">{error}</Banner> : null}

        <div className="row">
          <button className="primary" disabled={busy || !ready} onClick={() => void settle()}>
            Settle round {round.round}
          </button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- more controls */

function More({ tally, questionId, busy, call }: {
  tally: RecursionTally;
  questionId: string;
  busy: boolean;
  call: (fn: () => Promise<RoundAnswer>, onOk?: (a: RoundAnswer) => void) => Promise<void>;
}) {
  const [toAdd, setToAdd] = useState('');
  const [winner, setWinner] = useState('');
  const [fill, setFill] = useState<string[]>([]);
  const [shortlist, setShortlist] = useState<string[]>([]);

  const seats = tally.seats ?? 1;
  const round = tally.rounds[tally.rounds.length - 1];
  const open = round?.tally.gate_open ?? false;
  const nominating = tally.phase === 'nominating';
  const inRace = tally.candidates.filter((c) => c.status === 'in');
  const addable = tally.candidates.filter((c) => ['pool', 'dropped', 'withdrawn'].includes(c.status));
  const seatsLeft = seats - (tally.elected?.length ?? 0);

  const toggle = (list: string[], id: string, max = Infinity) =>
    list.includes(id) ? list.filter((x) => x !== id)
      : list.length < max ? [...list, id] : list;

  return (
    <details className="more-controls" style={{ marginTop: 12 }}>
      <summary>More controls</summary>
      <div className="stack" style={{ gap: 16, marginTop: 12 }}>
        {/* add from the pool */}
        <div className="row">
          <select className="grow" name="add_candidate" value={toAdd}
                  disabled={addable.length === 0}
                  onChange={(e) => setToAdd(e.target.value)}>
            <option value="">{addable.length === 0 ? 'Nobody left in the pool' : 'Add someone from the pool…'}</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}{c.status === 'dropped' ? ' (dropped)' : c.status === 'withdrawn' ? ' (withdrew)' : ''}
              </option>
            ))}
          </select>
          <button className="ghost" disabled={busy || !toAdd}
                  onClick={() => void call(() => api.addCandidate(questionId, toAdd), () => setToAdd(''))}>
            Add
          </button>
        </div>

        {/* the shortlist by hand, instead of nominations */}
        {nominating && !open ? (
          <div>
            <p className="faint" style={{ marginBottom: 6 }}>Skip nominations: choose who goes through to round 1</p>
            {tally.candidates.filter((c) => c.status === 'pool' || c.status === 'in').map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" name="shortlist" checked={shortlist.includes(c.id)}
                       onChange={() => setShortlist(toggle(shortlist, c.id))} />
                <span>{c.label}</span>
              </label>
            ))}
            <button className="ghost" disabled={busy || shortlist.length === 0}
                    onClick={() => void call(() => api.settleRound(questionId, undefined, shortlist), () => setShortlist([]))}>
              Use this shortlist of {shortlist.length}
            </button>
          </div>
        ) : null}

        {/* withdraw someone */}
        {!open && inRace.length > 0 ? (
          <div>
            <p className="faint" style={{ marginBottom: 6 }}>In the race</p>
            {inRace.map((c) => (
              <div key={c.id} className="row" style={{ marginBottom: 6 }}>
                <span className="grow">
                  {c.label}
                  {c.added_by_chair ? <span className="faint"> · added by you</span> : null}
                  {c.joined_round !== null && c.joined_round > tally.current_round
                    ? <span className="faint"> · joins round {c.joined_round}</span> : null}
                </span>
                <button className="ghost small" disabled={busy}
                        onClick={() => {
                          if (confirm(`Withdraw ${c.label} from the race?`)) {
                            void call(() => api.withdrawCandidate(questionId, c.id));
                          }
                        }}>
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* ending early */}
        {!open ? (
          seats > 1 ? (
            <div>
              <p className="faint" style={{ marginBottom: 6 }}>
                End the vote now: fill up to {seatsLeft} remaining seat{seatsLeft === 1 ? '' : 's'} with
              </p>
              {inRace.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" name="fill_seat" checked={fill.includes(c.id)}
                         onChange={() => setFill(toggle(fill, c.id, seatsLeft))} />
                  <span>{c.label}</span>
                </label>
              ))}
              <button className="danger" disabled={busy}
                      onClick={() => {
                        const text = fill.length
                          ? `End the vote, electing ${fill.length} more?`
                          : `End the vote with ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left empty?`;
                        if (confirm(text)) void call(() => api.endRecursionSeats(questionId, fill));
                      }}>
                End the vote
              </button>
            </div>
          ) : (
            <div className="row">
              <select className="grow" name="end_winner" value={winner}
                      onChange={(e) => setWinner(e.target.value)}>
                <option value="">End with no winner</option>
                {inRace.map((c) => <option key={c.id} value={c.id}>End with {c.label} as winner</option>)}
              </select>
              <button className="danger" disabled={busy}
                      onClick={() => {
                        const who = inRace.find((c) => c.id === winner)?.label;
                        if (confirm(who ? `End the vote with ${who} as the winner?` : 'End the vote with no winner?')) {
                          void call(() => api.endRecursion(questionId, winner || null));
                        }
                      }}>
                End the vote
              </button>
            </div>
          )
        ) : null}
      </div>
    </details>
  );
}

/* --------------------------------------------------------------- stages */

/**
 * Where the race is: Nominations, Round 1, Round 2 … with the rounds that are
 * done ticked and the current one marked. It grows a step each round; there is
 * never an end shown, because nobody knows where the end is.
 */
function Stages({ tally }: { tally: RecursionTally }) {
  const decided = tally.phase === 'decided';
  const seats = tally.seats ?? 1;
  const filled = tally.elected?.length ?? (tally.winner ? 1 : 0);
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} aria-label="Stages of the vote">
      {tally.rounds.map((r) => {
        const here = !decided && r.round === tally.current_round;
        const label = r.kind === 'nomination' ? 'Nominations' : `Round ${r.round}`;
        return (
          <Pill key={r.round} tone={here ? (r.tally.gate_open ? 'open' : 'accent') : r.settled ? 'carried' : 'closed'}>
            {r.settled ? '✓ ' : ''}{label}
          </Pill>
        );
      })}
      {decided
        ? seats > 1
          ? <Pill tone={filled === seats ? 'carried' : 'pending'}>{filled} of {seats} elected</Pill>
          : <Pill tone={tally.winner ? 'carried' : 'defeated'}>{tally.winner ? `Won: ${tally.winner.label}` : 'No winner'}</Pill>
        : null}
    </div>
  );
}
