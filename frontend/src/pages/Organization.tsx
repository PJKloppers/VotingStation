/**
 * One organization's published ballots.
 *
 * Where a code carrying a single slug lands. It is not the site-wide directory
 * that used to be on the front page -- it shows one organization, named by the
 * code in the reader's hand, and only what that organization has published.
 */
import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { href } from '../lib/router';
import type { OrgPage } from '../lib/types';
import { Banner, Card, Empty, Pill, Spinner } from '../components/ui';

export function Organization({ orgSlug }: { orgSlug: string }) {
  const [page, setPage] = useState<OrgPage | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.orgPage(orgSlug)
      .then((p) => { if (live) setPage(p); })
      .catch(() => { if (live) setPage(null); });
    return () => { live = false; };
  }, [orgSlug]);

  if (page === undefined) return <main className="narrow"><Spinner label="Finding them" /></main>;

  if (page === null) {
    return (
      <main className="narrow">
        <Banner kind="error">
          There is no organization at <span className="mono">/{orgSlug}</span>.
        </Banner>
      </main>
    );
  }

  const logo = api.logoUrl(page.org.logo_path);

  return (
    <main className="narrow">
      <div className="stack">
        <header className="ballot-head">
          {logo ? <img className="ballot-mark" src={logo} alt="" /> : null}
          <div>
            <p className="eyebrow">Organization</p>
            <h1>{page.org.name}</h1>
            {page.org.description ? <p className="lede">{page.org.description}</p> : null}
          </div>
        </header>

        {page.ballots.length === 0
          ? <Empty>Nothing published right now.</Empty>
          : page.ballots.map((b) => (
              <Card key={b.id}>
                <div className="row">
                  <div className="grow">
                    <h3>{b.title}</h3>
                    {b.description ? <p className="faint">{b.description}</p> : null}
                  </div>
                  <Pill tone={b.status === 'live' ? 'live' : 'closed'}>{b.status}</Pill>
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  {b.status === 'live'
                    ? <a className="btn btn-primary"
                         href={href(`/vote/${page.org.slug}/${b.slug}`)}>Vote</a>
                    : null}
                  {b.results_public
                    ? <a className="btn btn-ghost"
                         href={href(`/results/${page.org.slug}/${b.slug}`)}>Results</a>
                    : null}
                </div>
              </Card>
            ))}
      </div>
    </main>
  );
}
