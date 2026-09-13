/**
 * The camera, and a frame every so often.
 *
 * Shared by the two things that point it at a printed slip: the way in for a
 * voter, and the organizer's scanner for taking a PIN back off the roll. Both
 * want the same rear-facing stream, the same refusals reported the same way,
 * and neither wants to look at every frame -- that is wasted work on a phone.
 *
 * The decoders are not here. They are the heavy part, they differ between the
 * two callers, and both import them inside the effect so that a page which
 * never opens a camera never pays for them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'starting' | 'scanning' | 'blocked' | 'unsupported';

/** How often to look at a frame. */
export const EVERY_MS = 180;

export interface CameraHandles {
  video: React.RefObject<HTMLVideoElement | null>;
  canvas: React.RefObject<HTMLCanvasElement | null>;
  state: CameraState;
  error: string;
  /** Stops the stream. Safe to call more than once. */
  stop: () => void;
}

/**
 * Runs `onFrame` against the live image until it returns true, or the component
 * goes away.
 *
 * `onFrame` is handed the pixels and the size. Returning true stops the loop
 * and releases the camera -- which is what finding something means.
 *
 * `ready` is awaited once before the first frame: it is where a caller loads
 * whatever decoder it needs, so the camera and the code arrive together.
 */
export function useCamera(
  onFrame: (pixels: ImageData, width: number, height: number) => boolean | void,
  ready?: () => Promise<unknown>,
): CameraHandles {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>('starting');
  const [error, setError] = useState('');

  // Held in a ref so a caller may pass a fresh closure every render without
  // tearing the camera down and asking for it again.
  const frame = useRef(onFrame);
  frame.current = onFrame;

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

      if (ready) await ready();
      if (!live) return;

      try {
        stream.current = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        if (!live) return;
        setState('blocked');
        setError(
          window.isSecureContext
            ? 'The camera was refused. Allow it for this page, or type the PIN instead.'
            : 'The camera needs a secure connection (https). Type the PIN instead.',
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
              if (frame.current(ctx.getImageData(0, 0, w, h), w, h) === true) {
                stop();
                return;
              }
            }
          }
        }
        timer = setTimeout(look, EVERY_MS);
      };
      look();
    })();

    return () => { live = false; if (timer) clearTimeout(timer); stop(); };
    // `ready` and `onFrame` are deliberately not dependencies: see the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  return { video, canvas, state, error, stop };
}
