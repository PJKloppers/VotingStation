import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { href } from '../lib/router';
import type { Ballot, Organization } from '../lib/types';
import { Card, Empty, Pill, Spinner } from '../components/ui';

export function Home() {
  const [ballots, setBallots] = useState<Array<Ballot & { organizations: Organization }> | null>(null);

  useEffect(() => {
    api.liveBallots().then(setBallots).catch(() => setBallots([]));
  }, []);

  return (
    <main>
      <div className="stack">
        <header style={{ maxWidth: '46ch' }}>
          <p className="eyebrow">Token voting</p>
          <h1>Run a vote your members can trust.</h1>
          <p className="lede">
            Issue a six-digit PIN to each voter, open one question at a time from the
            chair, and let the count publish itself. Ballots are anonymous by default
            and the tally is public.
          </p>
        </header>

        <Card>
          <h2>Have a PIN?</h2>
          <p className="muted">
            Open the link your organizer sent you. It takes you straight to their
            ballot, where your PIN is the only thing you need.
          </p>
        </Card>

        <div className="section-head"><h2>Public ballots</h2></div>

        {ballots === null ? <Spinner label="Loading ballots" /> : null}
        {ballots?.length === 0 ? <Empty>No ballots have been published yet.</Empty> : null}

        {ballots?.map((b) => (
          <Card key={b.id}>
            <div className="row">
              <div className="grow">
                <p className="eyebrow">{b.organizations?.name ?? 'Organization'}</p>
                <h3>{b.title}</h3>
                {b.description ? <p className="faint">{b.description}</p> : null}
              </div>
              <Pill tone={b.status === 'live' ? 'live' : 'closed'}>{b.status}</Pill>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              {b.status === 'live'
                ? <a className="btn btn-primary" href={href(`/vote/${b.id}`)}>Vote</a>
                : null}
              {b.results_public
                ? <a className="btn btn-ghost" href={href(`/results/${b.id}`)}>Results</a>
                : null}
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}
