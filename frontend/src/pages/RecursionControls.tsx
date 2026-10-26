/**
 * The chair's controls for one recursion filter, on the Live tab.
 *
 * A round runs: open the gate, voters choose, close the gate, settle. The
 * phase bar at the top always shows where the race is and holds the one button
 * that moves it on, so the chair never has to hunt for the next step:
 *
 *   not opened → Open nominations / Open round N
 *   open       → Close nominations / Close round N
 *   closed     → Settle (with the drop count, for an elimination round)
 *   settled    → the next round, not opened yet, and round again
 *
 * Settling is the chair's decision and the only one the database will not make
 * alone -- how many drop, and who goes when the cut falls on a tie. Between
 * rounds the chair can also add someone from the pool, withdraw someone, or
 * end it.
 *
 * Every button here is a request. The database checks it again and answers in
 * a sentence when it will not do it, which is shown as it comes.
 */
import { useState } from 'react';
import * as api from '../lib/api';
import type { RoundAnswer } from '../lib/api';
import type { RecursionTally } from '../lib/types';
import { Banner, Field, Pill } from '../components/ui';
import { RecursionResult } from '../components/RecursionResult';

export function RecursionControls({ ballotId, questionId, tally, busy, act }: {
  ballotId: string;
  questionId: string;
  tally: RecursionTally;
  busy: boolean;
  /** Runs a call, then reloads the Live tab. */
  act: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [said, setSaid] = useState<{ kind: 'info' | 'error' | 'good'; text: string } | null>(null);
  const [tie, setTie] = useState<{ tied: Array<{ id: string; label: string }>; k: number } | null>(null);
  const [tieChoice, setTieChoice] = useState<string[]>([]);
  const [shortlisting, setShortlisting] = useState(false);
  const [shortlist, setShortlist] = useState<string[]>([]);
  const [toAdd, setToAdd] = useState('');
  const [winner, setWinner] = useState('');

  const round = tally.rounds[tally.rounds.length - 1];
  const current = round?.tally;
  const decided = tally.phase === 'decided';
  const nominating = tally.phase === 'nominating';
  const open = current?.gate_open ?? false;
  const opened = current?.opened ?? false;
  const inRace = tally.candidates.filter((c) => c.status === 'in');
  const addable = tally.candidates.filter((c) => ['pool', 'dropped', 'withdrawn'].includes(c.status));
  const roundSize = current?.options.length ?? 0;
  const name = nominating ? 'nominations' : `round ${tally.current_round}`;
  const Name = nominating ? 'Nominations' : `Round ${tally.current_round}`;

  const [drop, setDrop] = useState<string>(current?.drop_count == null ? '' : String(current.drop_count));

  /** Calls the database, and says what it answered. */
  const call = (fn: () => Promise<RoundAnswer>, onOk?: (a: RoundAnswer) => void) =>
    act(async () => {
      const answer = await fn();
      if (answer.ok) {
        setSaid(answer.message ? { kind: 'good', text: answer.message } : null);
        onOk?.(answer);
      } else if (answer.needs === 'tie_break' && answer.tied) {
        setTie({ tied: answer.tied, k: answer.drop_from_tie ?? 1 });
        setTieChoice([]);
        setSaid({ kind: 'info', text: answer.error ?? 'Break the tie.' });
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

  const settle = (tieDrop?: string[], list?: string[]) =>
    call(async () => {
      // The drop count typed in but not yet saved goes with the settle.
      if (!nominating && drop !== '' && Number(drop) !== current?.drop_count) {
        const set = await api.setRoundDropCount(questionId, Number(drop));
        if (!set.ok) return set;
      }
      return api.settleRound(questionId, tieDrop, list);
    }, () => {
      setTie(null); setShortlisting(false); setShortlist([]); setDrop('');
    });

  const toggle = (list: string[], id: string, max = Infinity) =>
    list.includes(id) ? list.filter((x) => x !== id)
      : list.length < max ? [...list, id] : list;

  return (
    <div style={{ marginTop: 14 }}>
      {/* ---------------------------------------------------- the phase bar */}
      <Phases tally={tally} />

      {decided ? null : (
        <div className="card" style={{ padding: 14, marginTop: 10 }}>
          <div className="row">
            <strong className="grow">{Name}</strong>
            {open ? <Pill tone="open">Voting</Pill>
              : opened ? <Pill tone="pending">Closed — settle it</Pill>
              : <Pill tone="closed">Not opened yet</Pill>}
          </div>

          {!opened && !open ? (
            <>
              <p className="faint" style={{ margin: '6px 0 10px' }}>
                {nominating
                  ? 'Open nominations to let voters name people from the pool.'
                  : `${roundSize} in this round. Open it to let voters choose.`}
              </p>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => void gate(true)}>
                  Open {name}
                </button>
                {nominating ? (
                  <button className="ghost" disabled={busy}
                          onClick={() => { setShortlisting(!shortlisting); setShortlist([]); }}>
                    {shortlisting ? 'Cancel' : 'Skip: choose the shortlist myself'}
                  </button>
                ) : null}
              </div>
            </>
          ) : open ? (
            <>
              <p className="faint" style={{ margin: '6px 0 10px' }}>
                {current?.voters ?? 0} voted so far. Close {name} when the room is done.
              </p>
              <button className="primary" disabled={busy} onClick={() => void gate(false)}>
                Close {name}
              </button>
            </>
          ) : (
            <>
              <p className="faint" style={{ margin: '6px 0 10px' }}>
                {nominating
                  ? `Settling puts everyone with ${tally.nominate_threshold} or more nomination${tally.nominate_threshold === 1 ? '' : 's'} through to round 1.`
                  : 'Settling drops the lowest and prepares the next round, or names the winner.'}
              </p>
              <div className="row">
                <button className="primary" disabled={busy}
                        onClick={() => void settle()}>
                  Settle {name}
                </button>
                {nominating ? (
                  <button className="ghost" disabled={busy}
                          onClick={() => { setShortlisting(!shortlisting); setShortlist([]); }}>
                    {shortlisting ? 'Cancel' : 'Choose the shortlist myself'}
                  </button>
                ) : null}
                <button className="ghost" disabled={busy} onClick={() => void gate(true)}>
                  Reopen
                </button>
              </div>
            </>
          )}

          {!nominating ? (
            <div className="row" style={{ marginTop: 12 }}>
              <Field label="How many drop out of this round"
                     help={`0 to ${Math.max(roundSize - 1, 0)}. Set it any time before you settle.`}>
                <input type="number" min={0} max={Math.max(roundSize - 1, 0)} name="drop_count"
                       value={drop} onChange={(e) => setDrop(e.target.value)} style={{ width: 100 }} />
              </Field>
              <button className="ghost" disabled={busy || drop === ''}
                      onClick={() => void call(() => api.setRoundDropCount(questionId, Number(drop)))}>
                Set
              </button>
            </div>
          ) : null}
        </div>
      )}

      {said ? <div style={{ marginTop: 12 }}><Banner kind={said.kind}>{said.text}</Banner></div> : null}

      {decided ? null : (
        <div className="stack" style={{ marginTop: 14, gap: 14 }}>
          {/* ---------------------------------------------------- a tie at the cut */}
          {tie ? (
            <div className="card" style={{ padding: 14 }}>
              <strong>Choose {tie.k} to drop</strong>
              <p className="faint">They are tied at the cut.</p>
              {tie.tied.map((t) => (
                <label key={t.id} className="check">
                  <input type="checkbox" checked={tieChoice.includes(t.id)}
                         onChange={() => setTieChoice(toggle(tieChoice, t.id, tie.k))} />
                  <span>{t.label}</span>
                </label>
              ))}
              <button className="primary" disabled={busy || tieChoice.length !== tie.k}
                      onClick={() => void settle(tieChoice)}>
                Drop {tieChoice.length === tie.k ? 'them' : `${tie.k}`} and settle
              </button>
            </div>
          ) : null}

          {/* ------------------------------------------- the shortlist by hand */}
          {shortlisting ? (
            <div className="card" style={{ padding: 14 }}>
              <strong>Who goes through to round 1?</strong>
              {tally.candidates.filter((c) => c.status === 'pool' || c.status === 'in').map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={shortlist.includes(c.id)}
                         onChange={() => setShortlist(toggle(shortlist, c.id))} />
                  <span>{c.label}</span>
                </label>
              ))}
              <button className="primary" disabled={busy || shortlist.length === 0}
                      onClick={() => void settle(undefined, shortlist)}>
                Use this shortlist of {shortlist.length}
              </button>
            </div>
          ) : null}

          {/* ------------------------------------------------- between rounds */}
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

          {/* ----------------------------------------------------- ending early */}
          {!open ? (
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
          ) : null}
        </div>
      )}

      {/* The count comes after the controls: a pool of thirty-odd names
          would otherwise push every button off the screen. */}
      <div style={{ marginTop: 18 }}>
        <RecursionResult tally={tally} chair />
      </div>
    </div>
  );
}

/**
 * Where the race is: Nominations, Round 1, Round 2 … with the rounds that are
 * done ticked and the current one marked. It grows a step each round; there is
 * never an end shown, because nobody knows where the end is.
 */
function Phases({ tally }: { tally: RecursionTally }) {
  const decided = tally.phase === 'decided';
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
        ? <Pill tone={tally.winner ? 'carried' : 'defeated'}>{tally.winner ? `Won: ${tally.winner.label}` : 'No winner'}</Pill>
        : null}
    </div>
  );
}
