/**
 * The public tally.
 *
 * Every number on this page is derived in the database at the moment it is
 * asked for, so what a reader sees is the vote log and not a running total
 * that might have drifted from it. Each question type is read by its own rule,
 * so the page states the outcome in that type's own language: a motion is
 * carried or defeated, an outright contest has a winner or a tie, and an
 * X-of-N contest names the elected and flags a tie at the cut-off rather than
 * breaking it silently.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type {
  BallotResults, CountedOption, HighestXTally, OutrightTally, QuestionResult, YesNoTally,
} from '../lib/types';
import { thresholdRule } from '../lib/rules';
import { Banner, Card, Empty, Pill, Spinner } from '../components/ui';

export function Results({ ballotId }: { ballotId: string }) {
  const [data, setData] = useState<BallotResults | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const answer = await api.ballotResults(ballotId);
      if (answer.ok) { setData(answer); setError(''); }
      else setError(answer.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the results.');
    } finally {
      setBusy(false);
    }
  }, [ballotId]);

  useEffect(() => { void load(); }, [load]);

  if (busy && !data) return <main><Spinner label="Counting" /></main>;
  if (error) return <main><Banner kind="error">{error}</Banner></main>;
  if (!data) return null;

  return (
    <main>
      <div className="section-head">
        {api.logoUrl(data.ballot.org_logo_path)
          ? <img className="ballot-mark" src={api.logoUrl(data.ballot.org_logo_path)!} alt="" />
          : null}
        <div>
          <p className="eyebrow">Results</p>
          <h1>{data.ballot.title}</h1>
          <p className="faint">
            {data.turnout.used} of {data.turnout.issued} PINs used · updated {data.updated.replace('T', ' ').replace('Z', ' UTC')}
          </p>
        </div>
        <div className="row-end">
          <button className="ghost" onClick={() => void load()} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {data.withheld > 0 ? (
        <Banner kind="info">
          {data.withheld} question{data.withheld === 1 ? ' is' : 's are'} still open.
          Each one publishes when the chair closes it.
        </Banner>
      ) : null}

      {data.questions.length === 0
        ? <Empty>
            {data.withheld > 0
              ? 'Nothing has been published yet.'
              : 'This ballot has no questions yet.'}
          </Empty>
        : <div className="stack">
            {data.questions.map((q) => (
              <Card key={q.id}><QuestionTally result={q} /></Card>
            ))}
          </div>}
    </main>
  );
}

/** One question's outcome. Shared with the voter's confirmation screen. */
export function QuestionTally({ result }: { result: QuestionResult }) {
  return (
    <>
      <div className="row" style={{ marginBottom: 4 }}>
        <h3 className="grow">{result.prompt}</h3>
        {result.gate_open ? <Pill tone="open">Gate open</Pill> : null}
      </div>
      {result.description ? <p className="faint">{result.description}</p> : null}
      <div style={{ marginTop: 14 }}>
        {result.type === 'yes_no' ? <YesNo tally={result.tally} /> : null}
        {result.type === 'highest_outright' ? <Outright tally={result.tally} /> : null}
        {result.type === 'highest_x' ? <HighestX tally={result.tally} /> : null}
      </div>
    </>
  );
}

function Bar({ label, votes, share, tone = '', countOnly = false }: {
  label: string; votes: number; share: number; tone?: string; countOnly?: boolean;
}) {
  return (
    <div className={`result-bar ${tone}`}>
      <span className="label">{label}</span>
      <span className="count">
        {votes}{countOnly ? '' : ` · ${(share * 100).toFixed(1)}%`}
      </span>
      <span className="track"><i style={{ width: `${Math.max(share * 100, votes > 0 ? 2 : 0)}%` }} /></span>
    </div>
  );
}

function YesNo({ tally }: { tally: YesNoTally }) {
  const of = tally.decisive || 1;
  const rule = thresholdRule(tally.threshold, tally.threshold_strict);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {tally.carried === null
          ? <Pill tone="pending">No votes yet</Pill>
          : tally.carried
            ? <Pill tone="carried">Carried</Pill>
            : <Pill tone="defeated">Defeated</Pill>}
        <span className="faint">Needs {rule}</span>
      </div>
      <Bar label={tally.labels.yes} votes={tally.yes} share={tally.yes / of}
           tone={tally.carried ? 'won' : ''} />
      <Bar label={tally.labels.no} votes={tally.no} share={tally.no / of}
           tone={tally.carried === false ? 'won' : ''} />
      {tally.abstain > 0
        ? <Bar label={tally.labels.abstain} votes={tally.abstain} share={0} tone="lost" countOnly />
        : null}
      <p className="faint" style={{ marginTop: 8 }}>
        {tally.voters} voted · {tally.decisive} decisive
        {tally.abstain > 0 ? ` · ${tally.abstain} abstained` : ''}
      </p>
    </>
  );
}

function Outright({ tally }: { tally: OutrightTally }) {
  const winner = tally.options.find((o) => o.id === tally.winner);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        {tally.total === 0 ? <Pill tone="pending">No votes yet</Pill>
          : tally.tied ? <Pill tone="pending">Tied</Pill>
          : winner ? <Pill tone="carried">{winner.label}</Pill>
          : <Pill tone="defeated">No outright winner</Pill>}
        {tally.require_majority && !tally.majority_reached && tally.total > 0
          ? <span className="faint">No option took more than half</span>
          : null}
      </div>
      {tally.options.map((o) => (
        <Bar key={o.id} label={o.label} votes={o.votes} share={o.share}
             tone={o.id === tally.winner ? 'won' : o.votes === 0 ? 'lost' : ''} />
      ))}
      <p className="faint" style={{ marginTop: 8 }}>
        {tally.voters} voted{tally.abstain > 0 ? ` · ${tally.abstain} abstained` : ''}
      </p>
    </>
  );
}

function HighestX({ tally }: { tally: HighestXTally }) {
  const elected = tally.options.filter((o: CountedOption) => o.elected);
  return (
    <>
      <p className="faint" style={{ marginBottom: 6 }}>Top {tally.winner_count} elected</p>
      {tally.total === 0
        ? <p className="outcome none">No votes yet</p>
        : <p className="outcome">{elected.map((o) => o.label).join(' · ')}</p>}
      {tally.tied_at_cut
        ? <Banner kind="info">
            The vote is tied at the cut-off. The last seat is not decided by this count.
          </Banner>
        : null}
      <div style={{ marginTop: 12 }}>
        {tally.options.map((o) => (
          <Bar key={o.id} label={o.label} votes={o.votes} share={o.share}
               tone={o.elected ? 'won' : o.votes === 0 ? 'lost' : ''} />
        ))}
      </div>
      <p className="faint" style={{ marginTop: 8 }}>
        {tally.voters} voted · {tally.total} selections · share is of voters, not of selections
      </p>
    </>
  );
}
