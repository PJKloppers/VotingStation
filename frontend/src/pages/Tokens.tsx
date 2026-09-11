/** Minting and managing a ballot's PINs. */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { TokenReport, TokenRow } from '../lib/types';
import { encodeQr, QUIET, qrPath } from '../lib/qr';
import { href } from '../lib/router';
import { Banner, Card, Field, Pill, Spinner } from '../components/ui';

export function Tokens({ ballotId, ballotTitle }: { ballotId: string; ballotTitle: string }) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [count, setCount] = useState(25);
  const [fresh, setFresh] = useState<Array<{ pin: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);

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

  /**
   * The browser's own print dialog, against a sheet that only exists on paper:
   * no popup to be blocked, no second document to keep in step with this one.
   *
   * The sheet is built on the first press and then left mounted -- hidden on
   * screen by the stylesheet, not by unmounting it. Tearing it down after
   * `window.print()` raced the dialog, and rendering it for every ballot
   * whether or not anyone prints would be a few thousand nodes nobody asked for.
   */
  const print = () => {
    setPrinting(true);
    // Let React paint the sheet before the dialog takes the page.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
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
          <button className="ghost small" onClick={print} disabled={report.issued === 0}>
            Print slips
          </button>
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
                              onClick={() => {
                                const warn = t.questions_voted > 0
                                  ? `Delete PIN ${t.pin}? Its ${t.questions_voted} vote(s) are deleted with it. Reset instead to void them and keep the trail.`
                                  : `Delete PIN ${t.pin}?`;
                                if (confirm(warn)) void api.deleteToken(t.id).then(load);
                              }}>
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

      {printing ? <PrintSheet ballotId={ballotId} title={ballotTitle} tokens={report.tokens} /> : null}
    </div>
  );
}

/**
 * One slip per PIN, to be cut up and handed out.
 *
 * Only on paper: `@media print` is what reveals it and hides the app around it.
 * Every slip carries the same QR -- it points at the ballot, not at the PIN --
 * so it is encoded once and drawn from the one path.
 */
function PrintSheet({ ballotId, title, tokens }: {
  ballotId: string; title: string; tokens: TokenRow[];
}) {
  const url = `${window.location.origin}${window.location.pathname}${href(`/vote/${ballotId}`)}`;
  const code = encodeQr(url);
  const live = tokens.filter((t) => t.status === 'active');

  // Eight to a sheet, decided here rather than left to whatever the paper and
  // the print dialog's scale setting happen to allow.
  const sheets: TokenRow[][] = [];
  for (let i = 0; i < live.length; i += 8) sheets.push(live.slice(i, i + 8));

  return (
    <div className="print-sheet" aria-hidden="true">
      {sheets.map((sheet, i) => (
        <div key={i} className={`print-page${i === sheets.length - 1 ? ' last' : ''}`}>
      {sheet.map((t) => (
        <div key={t.id} className="slip">
          {/* Black on white regardless of theme: a scanner wants dark modules
              on a light quiet zone, and paper is light either way. crispEdges
              so the modules do not blur into each other. */}
          {code ? (
            <svg className="slip-qr" shapeRendering="crispEdges"
                 viewBox={`0 0 ${code.size + QUIET * 2} ${code.size + QUIET * 2}`}
                 role="img" aria-label="Link to the ballot">
              <rect width="100%" height="100%" fill="#fff" />
              <path d={qrPath(code)} fill="#000" />
            </svg>
          ) : null}
          <div className="slip-body">
            <div className="slip-title">{title}</div>
            <div className="slip-pin">{t.pin}</div>
            <div className="slip-url">{url.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
      ))}
        </div>
      ))}
    </div>
  );
}
