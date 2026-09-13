/**
 * Taking a PIN off the roll by pointing a camera at its slip.
 *
 * The case this is for: a slip comes back, or one is handed out by mistake, and
 * the person at the desk has the paper in their hand and no wish to find six
 * digits in a table of two thousand. They scan it and it is gone.
 *
 * It reads either code on the slip. The barcode is the PIN and nothing else, so
 * it always works; the QR is the ballot's address and carries a PIN only when
 * the organizer chose to print it that way, so a QR from an ordinary sheet is
 * turned down with the reason rather than ignored.
 *
 * Everything heavy is loaded here rather than with the app: the whole module is
 * imported lazily by the PINs view, and the two decoders arrive with the camera
 * rather than with it. An organizer who never opens this pays for none of it.
 *
 * Deleting is not undoable and takes the votes with it, so each scan stops and
 * asks, with the vote count in the question. The camera picks up again after
 * the answer, because the point of this is a queue of people.
 */
import { useCallback, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useCamera } from '../lib/camera';
import { loadCodeReader, type CodeReader } from '../lib/codes';
import { pinFromScan } from '../lib/scan';
import type { TokenRow } from '../lib/types';
import { Banner } from './ui';

/** What the camera last found, and what is being asked about it. */
type Found =
  | { kind: 'asking'; token: TokenRow }
  | { kind: 'working'; token: TokenRow }
  | { kind: 'gone'; pin: string; votes: number }
  | { kind: 'unknown'; pin: string }
  | { kind: 'no-pin' };

export default function PinDeleteScanner(
  { tokens, onDeleted }: { tokens: TokenRow[]; onDeleted: () => void | Promise<void> },
) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string[]>([]);
  const read = useRef<CodeReader | null>(null);

  // Held in a ref so the frame callback always sees the current roll without
  // the camera being restarted every time the table behind it reloads.
  const roll = useRef(tokens);
  roll.current = tokens;

  // Paused while a question is on screen: the answer is what starts it again.
  const paused = useRef(false);
  const halted = found !== null;
  paused.current = halted;

  const load = useCallback(async () => {
    read.current = await loadCodeReader();
  }, []);

  const { video, canvas, state, error: cameraError } = useCamera((pixels) => {
    if (paused.current || !read.current) return;

    const text = read.current(pixels);
    if (!text) return;

    const pin = pinFromScan(text);
    if (!pin) { setFound({ kind: 'no-pin' }); return; }

    const token = roll.current.find((t) => t.pin === pin);
    setFound(token ? { kind: 'asking', token } : { kind: 'unknown', pin });
  }, load);

  const remove = async (token: TokenRow) => {
    setFound({ kind: 'working', token });
    setError('');
    try {
      await api.deleteToken(token.id);
      setDone((d) => [token.pin, ...d]);
      setFound({ kind: 'gone', pin: token.pin, votes: token.questions_voted });
      await onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that PIN.');
      setFound(null);
    }
  };

  return (
    <div className="stack-s">
      <div className="scanner">
        <div className="scanner-view">
          <video ref={video} playsInline muted aria-label="Camera" />
          <canvas ref={canvas} hidden />
          {state === 'scanning' && !halted
            ? <div className="scanner-reticle" aria-hidden="true" /> : null}
          {state === 'starting' ? <p className="scanner-note">Asking for the camera…</p> : null}
        </div>
      </div>

      {cameraError ? <Banner kind="error">{cameraError}</Banner> : null}
      {error ? <Banner kind="error">{error}</Banner> : null}

      {state === 'scanning' && !halted && !cameraError ? (
        <p className="faint">Point it at the barcode on a slip, or its QR if you printed the PIN into it.</p>
      ) : null}

      {found?.kind === 'asking' || found?.kind === 'working' ? (
        <div className="card scan-ask">
          <p className="eyebrow">Delete this PIN</p>
          <p className="pin-display">{found.token.pin}</p>
          <p className="faint">
            {found.token.questions_voted > 0
              ? `${found.token.questions_voted} vote${found.token.questions_voted === 1 ? '' : 's'} `
                + 'will be deleted with it. Use Reset in the table below to void them and keep the trail.'
              : 'It has not voted.'}
          </p>
          <div className="row">
            <button className="danger" disabled={found.kind === 'working'}
                    onClick={() => void remove(found.token)}>
              {found.kind === 'working' ? 'Deleting…' : 'Delete it'}
            </button>
            <button className="ghost" disabled={found.kind === 'working'}
                    onClick={() => setFound(null)}>Keep it</button>
          </div>
        </div>
      ) : null}

      {found?.kind === 'gone' ? (
        <Banner kind="good">
          {found.pin} deleted{found.votes > 0 ? `, with its ${found.votes} vote(s)` : ''}.{' '}
          <button className="ghost small" onClick={() => setFound(null)}>Scan the next one</button>
        </Banner>
      ) : null}

      {found?.kind === 'unknown' ? (
        <Banner kind="info">
          {found.pin} is not a PIN on this ballot — it may be from another one, or
          already deleted.{' '}
          <button className="ghost small" onClick={() => setFound(null)}>Try again</button>
        </Banner>
      ) : null}

      {found?.kind === 'no-pin' ? (
        <Banner kind="info">
          That code has no PIN in it. The barcode on the slip always does; the QR
          only when the sheet was printed with the PIN in it.{' '}
          <button className="ghost small" onClick={() => setFound(null)}>Try again</button>
        </Banner>
      ) : null}

      {done.length > 0 ? (
        <p className="faint">Deleted in this session: <span className="mono">{done.join(', ')}</span></p>
      ) : null}
    </div>
  );
}
