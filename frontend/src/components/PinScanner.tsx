/**
 * Reading a voter's own PIN off their slip, instead of typing it.
 *
 * Six digits is not much to type, but it is six digits in a hall, on a phone,
 * by someone who may be reading them off a small line of print. The slip has
 * them in a barcode already, so pointing the camera at it is the shorter way.
 *
 * Either code is read. The barcode holds the PIN and always works; the square
 * one holds the ballot's address and carries a PIN only if the organizer chose
 * to print it that way, so an ordinary sheet's QR is answered with the reason
 * rather than a shrug.
 *
 * This is the voter's side, so it is careful about two things the organizer's
 * scanner does not have to be. It never says whether a PIN is real -- that is
 * the server's answer to give, after the PIN is submitted, and saying it here
 * would turn the camera into a way of testing guesses. And it hands the PIN
 * straight up rather than displaying it, because a screen held up in a room is
 * a screen other people can read.
 */
import { useCallback, useRef, useState } from 'react';
import { useCamera } from '../lib/camera';
import { loadCodeReader, type CodeReader } from '../lib/codes';
import { pinFromScan } from '../lib/scan';
import { Banner } from './ui';

export default function PinScanner(
  { onFound, onCancel }: { onFound: (pin: string) => void; onCancel: () => void },
) {
  const read = useRef<CodeReader | null>(null);
  const [sawSomething, setSawSomething] = useState(false);

  const load = useCallback(async () => {
    read.current = await loadCodeReader();
  }, []);

  const { video, canvas, state, error } = useCamera((pixels) => {
    if (!read.current) return;
    const text = read.current(pixels);
    if (!text) return;

    const pin = pinFromScan(text);
    if (!pin) {
      // A code, but not one with a PIN in it. Keep looking rather than stop.
      setSawSomething(true);
      return;
    }
    onFound(pin);
    return true;
  }, load);

  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={video} playsInline muted aria-label="Camera" />
        <canvas ref={canvas} hidden />
        {state === 'scanning' ? <div className="scanner-reticle" aria-hidden="true" /> : null}
        {state === 'starting' ? <p className="scanner-note">Asking for the camera…</p> : null}
      </div>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {state === 'scanning' ? (
        <p className="faint">
          {sawSomething
            ? 'That code has no PIN in it. Point it at the barcode along the edge of your slip.'
            : 'Point it at the barcode along the edge of your slip.'}
        </p>
      ) : null}

      <button type="button" className="ghost block" onClick={onCancel}>
        Type it instead
      </button>
    </div>
  );
}
