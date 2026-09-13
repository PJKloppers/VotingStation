/**
 * The live monitor.
 *
 * What a chairperson puts on the projector: every question at once, the count
 * moving as it arrives, and the standing of each one stated in its own terms --
 * carried or defeated, who is leading, who is inside the cut.
 *
 * It reads as the organizer, which is the only reason it can show a tally at
 * all: while a ballot is live the public cannot see one.
 */
import { useEffect, useRef, useState } from 'react';
import '../live.css';
import * as api from '../lib/api';
import { useLiveResults, type LiveStatus } from '../lib/live';
import { thresholdRule } from '../lib/rules';
import { href, navigate } from '../lib/router';
import type {
  Ballot, HighestXTally, OutrightTally, QuestionResult, YesNoTally,
} from '../lib/types';
import { Banner, Card, Empty, Pill, Spinner } from '../components/ui';

export function Live({ ballotId }: { ballotId: string }) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [missing, setMissing] = useState(false);
  const { results, error, status, updatedAt, changes, refresh } = useLiveResults(ballotId);

  useEffect(() => {
    api.ballotById(ballotId)
      .then((b) => { setBallot(b); if (!b) setMissing(true); })
      .catch(() => setMissing(true));
  }, [ballotId]);

  if (missing) {
    return (
      <main className="narrow">
        <Card>
          <h1>Not your ballot</h1>
          <p className="lede">It may have been deleted, or belong to someone else.</p>
          <button className="primary" onClick={() => navigate('/admin')}>Your ballots</button>
        </Card>
      </main>
    );
  }

  if (!results && !error) return <main><Spinner label="Reading the count" /></main>;

  return (
    <main className="monitor">
      <header className="monitor-head">
        <div>
          <p className="eyebrow">Live results</p>
          <h1>{ballot?.title ?? results?.ballot.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <Link status={status} />
            <span className="faint">
              {updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : 'not read yet'}
            </span>
            <button className="ghost small" onClick={refresh}>Refresh</button>
            <a className="btn btn-ghost small" href={href(`/manage/${ballotId}`)}>Manage</a>
          </div>
        </div>

        {results ? (
          <div className="turnout">
            <div>
              <div className="figure">
                {results.turnout.used}<span className="of"> / {results.turnout.issued}</span>
              </div>
              <div className="what">PINs used</div>
            </div>
            <div>
              <div className="figure">{results.questions.length}</div>
              <div className="what">Questions</div>
            </div>
          </div>
        ) : null}
      </header>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {results && results.questions.length === 0
        ? <Empty>This ballot has no questions yet.</Empty>
        : null}

      <div className="monitor-grid">
        {results?.questions.map((q) => (
          <MonitorCard key={q.id} result={q} changes={changes} />
        ))}
      </div>
    </main>
  );
}

function Link({ status }: { status: LiveStatus }) {
  const said: Record<LiveStatus, string> = {
    live: 'Live',
    polling: 'Reconnecting — refreshing every 15s',
    connecting: 'Connecting',
  };
  return (
    <span className={`link-state ${status}`}>
      <span className="dot" aria-hidden="true" />
      {said[status]}
    </span>
  );
}

/**
 * One question. `changes` only ever goes up, so a card can notice that
 * something landed while it was on screen and flicker once.
 */
function MonitorCard({ result, changes }: { result: QuestionResult; changes: number }) {
  const [moved, setMoved] = useState(false);
  const seen = useRef(changes);

  useEffect(() => {
    if (changes === seen.current) return;
    seen.current = changes;
    setMoved(true);
    const id = setTimeout(() => setMoved(false), 900);
    return () => clearTimeout(id);
  }, [changes]);

  return (
    <div className={`card monitor-card${moved ? ' just-moved' : ''}`}>
      <div className="row">
        <h2 className="grow">{result.prompt}</h2>
        {result.gate_open ? <Pill tone="open">Gate open</Pill> : <Pill tone="closed">Closed</Pill>}
      </div>

      {result.type === 'yes_no' ? <YesNo tally={result.tally} /> : null}
      {result.type === 'highest_outright' ? <Outright tally={result.tally} /> : null}
      {result.type === 'highest_x' ? <HighestX tally={result.tally} /> : null}
    </div>
  );
}

function Bar({ label, votes, share, tone = '', countOnly = false }: {
  label: string; votes: number; share: number; tone?: string; countOnly?: boolean;
}) {
  return (
    <div className={`result-bar ${tone}`}>
      <span className="label">{label}</span>
      <span className="count">{votes}{countOnly ? '' : ` · ${(share * 100).toFixed(1)}%`}</span>
      <span className="track"><i style={{ width: `${Math.max(share * 100, votes > 0 ? 2 : 0)}%` }} /></span>
    </div>
  );
}

function YesNo({ tally }: { tally: YesNoTally }) {
  const of = tally.decisive || 1;
  return (
    <>
      <p className={`headline ${tally.carried === null ? 'waiting' : tally.carried ? 'carried' : 'defeated'}`}>
        {tally.carried === null ? 'No votes yet' : tally.carried ? 'Carried' : 'Defeated'}
      </p>
      <Bar label={tally.labels.yes} votes={tally.yes} share={tally.yes / of}
           tone={tally.carried ? 'won' : ''} />
      <Bar label={tally.labels.no} votes={tally.no} share={tally.no / of}
           tone={tally.carried === false ? 'won' : ''} />
      {tally.abstain > 0
        ? <Bar label={tally.labels.abstain} votes={tally.abstain} share={0} tone="lost" countOnly />
        : null}
      <p className="faint" style={{ marginTop: 'auto', paddingTop: 10 }}>
        {tally.voters} voted · {tally.decisive} decisive · needs{' '}
        {thresholdRule(tally.threshold, tally.threshold_strict)}
      </p>
    </>
  );
}

function Outright({ tally }: { tally: OutrightTally }) {
  const winner = tally.options.find((o) => o.id === tally.winner);
  const headline = tally.total === 0 ? 'No votes yet'
    : tally.tied ? 'Tied'
    : winner ? winner.label
    : 'No outright winner';

  return (
    <>
      <p className={`headline ${tally.total === 0 || !winner ? 'waiting' : 'carried'}`}>
        {headline}
      </p>
      {tally.options.map((o) => (
        <Bar key={o.id} label={o.label} votes={o.votes ?? 0} share={o.share ?? 0}
             tone={o.id === tally.winner ? 'won' : o.votes === 0 ? 'lost' : ''} />
      ))}
      <p className="faint" style={{ marginTop: 'auto', paddingTop: 10 }}>
        {tally.voters} voted{tally.abstain > 0 ? ` · ${tally.abstain} abstained` : ''}
        {tally.require_majority ? ' · needs an outright majority' : ''}
      </p>
    </>
  );
}

function HighestX({ tally }: { tally: HighestXTally }) {
  const elected = tally.options.filter((o) => o.elected);
  return (
    <>
      <p className={`headline ${tally.total === 0 ? 'waiting' : 'carried'}`}>
        {tally.total === 0 ? 'No votes yet' : elected.map((o) => o.label).join(' · ')}
      </p>
      {tally.tied_at_cut
        ? <Banner kind="info">Tied at the cut-off — the last seat is not decided.</Banner>
        : null}
      {/* The monitor reads as the owner, so a count is always there -- the null
          is only ever the public shape of this same type. */}
      <div style={{ marginTop: tally.tied_at_cut ? 12 : 0 }}>
        {tally.options.map((o) => (
          <Bar key={o.id} label={o.label} votes={o.votes ?? 0} share={o.share ?? 0}
               tone={o.elected ? 'won' : o.votes === 0 ? 'lost' : ''} />
        ))}
      </div>
      <p className="faint" style={{ marginTop: 'auto', paddingTop: 10 }}>
        {tally.voters} voted · top {tally.winner_count} elected
      </p>
    </>
  );
}
