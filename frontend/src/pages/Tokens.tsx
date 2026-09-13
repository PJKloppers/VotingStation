/** Minting and managing a ballot's PINs. */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { TokenReport, TokenRow } from '../lib/types';
import { encodeQr, QUIET, qrPath, type QrCode } from '../lib/qr';
import { barcodePath, encodeBarcode, type Barcode } from '../lib/barcode';
import { appBase, href } from '../lib/router';
import { Banner, Card, Check, Field, Pill, Spinner } from '../components/ui';

/**
 * The camera and its two decoders are a large thing to carry for a page that is
 * mostly a table, so they arrive only if somebody opens the scanner.
 */
const PinDeleteScanner = lazy(() => import('../components/PinDeleteScanner'));

/** Slips to a printed page. The stylesheet lays out this many rows. */
const PER_PAGE = 16;

export function Tokens({ ballotId, ballotTitle }: { ballotId: string; ballotTitle: string }) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [count, setCount] = useState(25);
  const [fresh, setFresh] = useState<Array<{ pin: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [mark, setMark] = useState<string | null>(null);
  const [slugs, setSlugs] = useState<{ org: string; ballot: string } | null>(null);
  // Off every time the page loads, deliberately: it makes the printed code the
  // credential, and that is not a decision to leave switched on by accident.
  const [embedPin, setEmbedPin] = useState(false);
  const [scanning, setScanning] = useState(false);

  // The slip carries the readable link, so the page needs the pair of slugs.
  useEffect(() => {
    let live = true;
    api.ballotSlugs(ballotId)
      .then((s) => { if (live) setSlugs(s); })
      .catch(() => {});
    return () => { live = false; };
  }, [ballotId]);

  // Inlined as a data URI rather than left as a URL: window.print() does not
  // wait for a network image, and a sheet that prints with a hole in every QR
  // is worse than one with no mark at all.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const url = api.logoUrl(await api.ballotLogoPath(ballotId));
        if (!url) return;
        const blob = await (await fetch(url)).blob();
        const reader = new FileReader();
        reader.onload = () => { if (live) setMark(String(reader.result)); };
        reader.readAsDataURL(blob);
      } catch { /* a missing mark is not a reason to fail the page */ }
    })();
    return () => { live = false; };
  }, [ballotId]);

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
          <button className="ghost small" onClick={() => setScanning((v) => !v)}
                  disabled={report.issued === 0}>
            {scanning ? 'Close scanner' : 'Scan to delete'}
          </button>
          <button className="ghost small" onClick={print} disabled={report.issued === 0}>
            Print slips
          </button>
          <button className="ghost small" onClick={download} disabled={report.issued === 0}>
            Download CSV
          </button>
        </div>

        {scanning ? (
          <div style={{ marginTop: 14 }}>
            <Suspense fallback={<Spinner label="Opening the camera" />}>
              <PinDeleteScanner tokens={report.tokens} onDeleted={load} />
            </Suspense>
          </div>
        ) : null}

        <Check
          label="Put the PIN in the code as well"
          checked={embedPin}
          onChange={setEmbedPin}
          help="Scanning the slip opens the ballot and signs that voter straight in. It also makes the printed code the vote: anyone who photographs the slip can use it. Off unless you turn it on."
        />

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

      {printing
        ? <PrintSheet ballotId={ballotId} title={ballotTitle}
                      tokens={report.tokens} mark={mark} slugs={slugs}
                      embedPin={embedPin} />
        : null}
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
/**
 * The code with the organization's mark in the middle.
 *
 * The encoder is error correction level M, which recovers about 15% of a
 * damaged code. The patch below covers roughly 5% of the area, well inside
 * that -- and the printed result is decoded in the test rather than assumed.
 */
/**
 * The PIN as a row of bars, on the right of every slip.
 *
 * The big code points at the ballot, and only carries the PIN when the
 * organizer has asked it to. This one always carries the PIN and nothing else,
 * so a scanner at the door reads the six digits off any slip whichever way
 * that setting is left -- and a barcode is what the hand-held scanner on a
 * desk is, where a phone is what reads the square one.
 *
 * Drawn at its own aspect ratio rather than squeezed into a square: the width
 * is fixed by the symbol, and the height is free, so the bars are given the
 * room the layout has and no more.
 */
function PinBarcode({ code }: { code: Barcode }) {
  // A stated height in modules, so the viewBox carries the proportion and the
  // stylesheet only has to say how wide the thing is.
  const height = 26;
  return (
    <svg className="slip-pin-code" shapeRendering="crispEdges"
         viewBox={`0 0 ${code.width} ${height}`} preserveAspectRatio="none"
         role="img" aria-label={`The PIN, as a barcode: ${code.text}`}>
      <rect width="100%" height="100%" fill="#fff" />
      <path d={barcodePath(code, height)} fill="#000" />
    </svg>
  );
}

function QrWithMark({ code, mark }: { code: QrCode; mark: string | null }) {
  const span = code.size + QUIET * 2;
  const patch = span * 0.22;
  const at = (span - patch) / 2;

  return (
    <svg className="slip-qr" shapeRendering="crispEdges"
         viewBox={`0 0 ${span} ${span}`}
         role="img" aria-label="Link to the ballot">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={qrPath(code)} fill="#000" />
      {mark ? (
        <>
          {/* A quiet square under it, or the mark sits on modules and the
              scanner has two problems instead of one. */}
          <rect x={at - 0.6} y={at - 0.6} width={patch + 1.2} height={patch + 1.2}
                rx={1} fill="#fff" />
          <image href={mark} x={at} y={at} width={patch} height={patch}
                 preserveAspectRatio="xMidYMid meet" />
        </>
      ) : null}
    </svg>
  );
}

function PrintSheet({ ballotId, title, tokens, mark, slugs, embedPin }: {
  ballotId: string; title: string; tokens: TokenRow[]; mark: string | null;
  slugs: { org: string; ballot: string } | null;
  embedPin: boolean;
}) {
  // The readable form, because a slip is read by a person and typed by one.
  // The uuid is the fallback for a draft, whose slugs are not resolvable yet.
  const path = slugs ? `/vote/${slugs.org}/${slugs.ballot}` : `/vote/${ballotId}`;
  const base = `${appBase()}${href(path)}`;
  const live = tokens.filter((t) => t.status === 'active');

  /*
   * With the PIN in it, every slip's code is different, so each is encoded on
   * its own. Without it they are all the same code, and encoding it once for
   * two thousand slips is the difference between instant and not.
   */
  const shared = embedPin ? null : encodeQr(base);

  // Sixteen to a sheet, decided here rather than left to whatever the paper and
  // the print dialog's scale setting happen to allow.
  const sheets: TokenRow[][] = [];
  for (let i = 0; i < live.length; i += PER_PAGE) sheets.push(live.slice(i, i + PER_PAGE));

  // The code's viewBox includes its quiet zone -- four blank modules a side --
  // so the dark part fills only this fraction of the box it is given. The mark
  // is scaled to match, or the two are the same box at visibly different sizes.
  const gauge = shared ?? encodeQr(`${base}?pin=000000`);
  const inkRatio = gauge ? gauge.size / (gauge.size + QUIET * 2) : 1;

  return (
    <div className="print-sheet" aria-hidden="true"
         style={{ ['--mark-scale' as string]: String(inkRatio) }}>
      {sheets.map((sheet, i) => (
        <div key={i} className={`print-page${i === sheets.length - 1 ? ' last' : ''}`}>
      {sheet.map((t) => {
        const url = embedPin ? `${base}?pin=${t.pin}` : base;
        const code = shared ?? encodeQr(url);
        const pinCode = encodeBarcode(t.pin);
        return (
        <div key={t.id} className="slip">
          {/* Black on white regardless of theme: a scanner wants dark modules
              on a light quiet zone, and paper is light either way. crispEdges
              so the modules do not blur into each other. */}
          {code ? <QrWithMark code={code} mark={mark} /> : null}
          <div className="slip-body">
            <div className="slip-title">{title}</div>
            <div className="slip-pin">{t.pin}</div>
            <div className="slip-url">{url.replace(/^https?:\/\//, '')}</div>
          </div>
          {/* The mark balances the code across the slip, at the same size. */}
          {mark ? <img className="slip-mark" src={mark} alt="" /> : null}
          {/* Rightmost, and on every slip: the PIN as a code in its own right. */}
          {pinCode ? <PinBarcode code={pinCode} /> : null}
        </div>
        );
      })}
        </div>
      ))}
    </div>
  );
}
