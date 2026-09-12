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
import { useCallback, useEffect, useRef, useState } from 'react';
import { readDestination, type Destination } from '../lib/scan';
import { Banner } from './ui';

type State = 'starting' | 'scanning' | 'blocked' | 'unsupported';

/** How often to look at a frame. Every frame is wasted work on a phone. */
const EVERY_MS = 180;

export default function Scanner({ onFound }: { onFound: (to: Destination) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<State>('starting');
  const [error, setError] = useState('');
  const [sawSomething, setSawSomething] = useState(false);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unsupported');
        setError('This browser will not give a page the camera.');
        return;
      }

      // The decoder is the heaviest thing here, so it arrives with the camera
      // rather than with the app.
      const { default: jsQR } = await import('jsqr');

      try {
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (e) {
        if (!live) return;
        setState('blocked');
        setError(
          window.isSecureContext
            ? 'The camera was refused. Allow it for this page, or type the link instead.'
            : 'The camera needs a secure connection (https). Type the link instead.',
        );
        return;
      }

      if (!live) { stop(); return; }
      const el = video.current;
      if (!el) return;
      el.srcObject = stream.current;
      await el.play().catch(() => {});
      setState('scanning');

      const look = () => {
        if (!live) return;
        const c = canvas.current;
        const v = video.current;
        if (c && v && v.readyState === v.HAVE_ENOUGH_DATA) {
          const w = v.videoWidth;
          const h = v.videoHeight;
          if (w && h) {
            c.width = w; c.height = h;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(v, 0, 0, w, h);
              const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
                inversionAttempts: 'dontInvert',
              });
              if (found) {
                const to = readDestination(found.data);
                if (to) { stop(); onFound(to); return; }
                // A code, but not one of ours -- say so rather than sit there.
                setSawSomething(true);
              }
            }
          }
        }
        timer = setTimeout(look, EVERY_MS);
      };
      look();
    })();

    return () => { live = false; if (timer) clearTimeout(timer); stop(); };
  }, [onFound, stop]);

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
