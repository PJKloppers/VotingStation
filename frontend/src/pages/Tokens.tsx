/** Minting and managing a ballot's PINs. */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { TokenReport } from '../lib/types';
import { Banner, Card, Field, Pill, Spinner } from '../components/ui';

export function Tokens({ ballotId }: { ballotId: string }) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [count, setCount] = useState(25);
  const [fresh, setFresh] = useState<Array<{ pin: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await api.tokenReport(ballotId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the PINs.');
    }
  }, [ballotId]);

  useEffect(() => { void load(); }, [load]);

  const issue = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      setFresh(await api.issueTokens(ballotId, count));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not issue PINs.');
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!report) return;
    const rows = [['pin', 'status', 'questions_voted'].join(',')]
      .concat(report.tokens.map((t) => [t.pin, t.status, t.questions_voted].join(',')));
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'pins.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  if (!report) return <Spinner label="Loading PINs" />;

  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}

      <Card>
        <h3>Issue PINs</h3>
        <p className="faint">
          Six digits each, unique to this ballot. The same PIN can exist on another
          ballot without clashing.
        </p>
        <form onSubmit={issue}>
          <Field label="How many">
            <input type="number" min={1} max={2000} value={count} name="pin_count"
                   onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Minting…' : `Issue ${count} PINs`}
          </button>
        </form>

        {fresh.length > 0 ? (
          <div style={{ marginTop: 18 }}>
            <p className="eyebrow">Just issued</p>
            <div className="pin-grid">
              {fresh.map((t) => (
                <div key={t.pin} className="pin-chip">
                  <div className="pin">{t.pin}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <div className="row">
          <div className="grow">
            <h3>All PINs</h3>
            <p className="faint">
              {report.issued} issued · {report.used} used · {report.disabled} disabled
            </p>
          </div>
          <button className="ghost small" onClick={download} disabled={report.issued === 0}>
            Download CSV
          </button>
        </div>

        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>PIN</th><th>Status</th><th>Voted</th><th /></tr>
            </thead>
            <tbody>
              {report.tokens.map((t) => (
                <tr key={t.id}>
                  <td className="pin-display">{t.pin}</td>
                  <td>
                    {t.status === 'disabled'
                      ? <Pill tone="defeated">disabled</Pill>
                      : t.questions_voted > 0 ? <Pill tone="carried">used</Pill> : <Pill>unused</Pill>}
                  </td>
                  <td className="mono">{t.questions_voted}</td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <button className="ghost small"
                              onClick={() => void api.setTokenStatus(t.id, t.status === 'disabled' ? 'active' : 'disabled').then(load)}>
                        {t.status === 'disabled' ? 'Enable' : 'Disable'}
                      </button>
                      <button className="ghost small" disabled={t.questions_voted === 0}
                              onClick={() => { if (confirm(`Void every vote cast with ${t.pin}?`)) void api.resetToken(t.id).then(load); }}>
                        Reset
                      </button>
                      <button className="danger small"
                              onClick={() => { if (confirm(`Delete PIN ${t.pin}?`)) void api.deleteToken(t.id).then(load); }}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
