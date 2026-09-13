/**
 * The camera, pointed at a printed slip.
 *
 * Lazily loaded, and so is the decoder inside it: a voter who types a link, or
 * arrives at a ballot by its own URL, should never pay for either. Nothing here
 * is imported at the top of the app.
 *
 * The camera needs a secure context -- https, or localhost -- so plain http on
 * a venue's LAN will refuse it. That is exactly why the page it sits on keeps a
 * way in that does not involve a camera.
 */
import { useCallback, useRef, useState } from 'react';
import { useCamera } from '../lib/camera';
import { readDestination, type Destination } from '../lib/scan';
import { Banner } from './ui';

export default function Scanner({ onFound }: { onFound: (to: Destination) => void }) {
  const [sawSomething, setSawSomething] = useState(false);
  const decode = useRef<((d: Uint8ClampedArray, w: number, h: number) => { data: string } | null) | null>(null);

  // The decoder is the heaviest thing here, so it arrives with the camera
  // rather than with the app.
  const load = useCallback(async () => {
    const { default: jsQR } = await import('jsqr');
    decode.current = (d, w, h) => jsQR(d, w, h, { inversionAttempts: 'dontInvert' });
  }, []);

  const { video, canvas, state, error } = useCamera((pixels, w, h) => {
    const found = decode.current?.(pixels.data, w, h);
    if (!found) return;
    const to = readDestination(found.data);
    if (to) { onFound(to); return true; }
    // A code, but not one of ours -- say so rather than sit there.
    setSawSomething(true);
  }, load);

  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={video} playsInline muted aria-label="Camera" />
        <canvas ref={canvas} hidden />
        {state === 'scanning' ? <div className="scanner-reticle" aria-hidden="true" /> : null}
        {state === 'starting' ? <p className="scanner-note">Asking for the camera…</p> : null}
      </div>

      {state === 'scanning' ? (
        <p className="faint">
          {sawSomething
            ? 'That code is not a VotingStation link. Try the one on your slip.'
            : 'Point it at the code on your slip.'}
        </p>
      ) : null}
      {error ? <Banner kind="error">{error}</Banner> : null}
    </div>
  );
}
