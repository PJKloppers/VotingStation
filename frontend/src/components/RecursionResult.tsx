/**
 * A recursion filter's count: where the race stands, then each round, newest
 * first, with who went out of it and why.
 *
 * Shared by the public results, the voter's confirmation and the live monitor.
 * What each of those may see is decided in the database; this only lays out
 * what it is handed.
 */
import type { RecursionRound, RecursionTally } from '../lib/types';
import { Banner, Pill } from './ui';

export function RecursionResult({ tally, chair = false }: {
  tally: RecursionTally;
  /** The chair sees an unsettled round's projected cut; nobody else needs it. */
  chair?: boolean;
}) {
  // Rounds that have not been opened yet hold nothing to show.
  const shown = tally.rounds
    .filter((r) => r.settled || r.tally.opened || r.tally.voters > 0)
    .slice()
    .reverse();

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {tally.winner
          ? <Pill tone="carried">{tally.winner.label}</Pill>
          : tally.phase === 'decided'
            ? <Pill tone="defeated">Ended with no winner</Pill>
            : <Pill tone="pending">{headline(tally)}</Pill>}
        <span className="faint">{inTheRace(tally)}</span>
      </div>

      {shown.length === 0 ? <p className="outcome none">No votes yet</p> : null}

      <div className="stack" style={{ gap: 18 }}>
        {shown.map((r) => (
          <Round key={r.round} round={r} chair={chair}
                 winner={tally.winner?.id ?? null} threshold={tally.nominate_threshold} />
        ))}
      </div>
    </>
  );
}

function headline(t: RecursionTally): string {
  if (t.phase === 'nominating') return 'Nominations';
  return `Round ${t.current_round}`;
}

function inTheRace(t: RecursionTally): string {
  if (t.phase === 'decided') {
    const how = t.rounds[t.rounds.length - 1]?.how;
    return how === 'majority' ? 'Won with a majority'
      : how === 'last_left' ? 'The last one in'
      : how === 'chair' ? 'Named by the chair'
      : '';
  }
  const still = t.candidates.filter((c) => c.status === 'in').length;
  return t.phase === 'nominating' ? '' : `${still} still in`;
}

function Round({ round, chair, winner, threshold }: {
  round: RecursionRound; chair: boolean; winner: string | null; threshold: number;
}) {
  const t = round.tally;
  const nomination = round.kind === 'nomination';
  // A nomination round lists the whole pool; only the named are worth a bar.
  const rows = nomination ? t.options.filter((o) => o.votes > 0) : t.options;
  const unnamed = t.options.length - rows.length;

  return (
    <section>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong className="grow">{nomination ? 'Nominations' : `Round ${round.round}`}</strong>
        {t.gate_open ? <Pill tone="open">Open</Pill>
          : round.settled ? null
          : t.opened ? <Pill tone="pending">To settle</Pill> : null}
      </div>

      {rows.map((o) => {
        const out = round.settled && (round.dropped ?? []).some((d) => d.id === o.id);
        const tone = o.id === winner ? 'won'
          : nomination ? (o.qualifies ? '' : 'lost')
          : out ? 'lost' : '';
        return (
          <div key={o.id} className={`result-bar ${tone}`}>
            <span className="label">
              {o.label}
              {out ? ' — out' : ''}
              {!round.settled && chair && o.drops ? ' — would drop' : ''}
              {!round.settled && chair && o.tied ? ' — tied at the cut' : ''}
            </span>
            <span className="count">
              {o.votes}{t.ballots > 0 ? ` · ${(o.share * 100).toFixed(1)}%` : ''}
            </span>
            <span className="track">
              <i style={{ width: `${Math.max(o.share * 100, o.votes > 0 ? 2 : 0)}%` }} />
            </span>
          </div>
        );
      })}

      {nomination && unnamed > 0 ? (
        <p className="faint" style={{ marginTop: 6 }}>
          {rows.length === 0 ? `Nobody nominated yet out of ${unnamed} in the pool.` : `${unnamed} other${unnamed === 1 ? '' : 's'} in the pool with no nominations.`}
        </p>
      ) : null}

      <p className="faint" style={{ marginTop: 6 }}>{roundNote(round, threshold)}</p>

      {chair && !round.settled && t.tie_drop_count > 0 ? (
        <Banner kind="info">
          The cut falls on a tie. You will choose {t.tie_drop_count} of the tied to drop when you settle.
        </Banner>
      ) : null}
    </section>
  );
}

function roundNote(r: RecursionRound, threshold: number): string {
  const t = r.tally;
  const parts = [`${t.voters} voted`];
  if (t.abstain > 0) parts.push(`${t.abstain} abstained`);

  if (r.kind === 'nomination') {
    if (r.settled) {
      parts.push(r.shortlist_by_chair
        ? `shortlist of ${r.shortlisted?.length ?? 0} set by the chair`
        : `${r.shortlisted?.length ?? 0} reached ${threshold} nomination${threshold === 1 ? '' : 's'}`);
    } else {
      parts.push(`${threshold} nomination${threshold === 1 ? '' : 's'} to go through`);
    }
  } else if (r.settled) {
    if (r.how === 'majority') parts.push('a majority ended it');
    else if (r.ended_by_chair) parts.push('ended by the chair');
    else if ((r.dropped ?? []).length === 0) parts.push('nobody dropped');
    if (r.tie_broken_by_chair) parts.push('tie at the cut broken by the chair');
  } else if (t.drop_count !== null) {
    parts.push(`${t.drop_count} to drop`);
  }
  if ((r.withdrawn ?? []).length > 0) {
    parts.push(`withdrew: ${r.withdrawn!.map((w) => w.label).join(', ')}`);
  }
  return parts.join(' · ');
}
