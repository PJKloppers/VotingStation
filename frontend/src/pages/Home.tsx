/**
 * The front page.
 *
 * A voter arrives holding a printed slip, so the page is a camera pointed at
 * it. The code carries the ballot's own link, which is what makes a code only
 * have to be unique on the ballot it belongs to -- nothing here searches for a
 * PIN, because nothing here knows or needs to know one.
 *
 * The scanner is loaded on demand. A voter who types the link, or who follows
 * one straight to a ballot, never downloads a camera or a decoder.
 */
import { lazy, Suspense, useCallback, useState } from 'react';
import { navigate } from '../lib/router';
import { readDestination, routeFor, type Destination } from '../lib/scan';
import { Banner, Card, Field, Spinner } from '../components/ui';

const Scanner = lazy(() => import('../components/Scanner'));

export function Home() {
  const [scanning, setScanning] = useState(false);

  const go = useCallback((to: Destination) => {
    setScanning(false);
    navigate(routeFor(to));
  }, []);

  return (
    <main className="narrow">
      <div className="stack">
        <header style={{ maxWidth: '38ch' }}>
          <p className="eyebrow">Token voting</p>
          <h1>Scan the code on your slip.</h1>
        </header>

        <Card>
          {scanning ? (
            <Suspense fallback={<Spinner label="Starting the camera" />}>
              <Scanner onFound={go} />
            </Suspense>
          ) : (
            <>
              <p className="muted">
                Your organizer handed you a slip with a code on it. Scan it and you
                will land on the right ballot, where your PIN opens your vote.
              </p>
              <button className="primary block" style={{ marginTop: 6 }}
                      onClick={() => setScanning(true)}>
                Scan a code
              </button>
            </>
          )}

          {scanning ? (
            <button className="ghost block" style={{ marginTop: 12 }}
                    onClick={() => setScanning(false)}>
              Stop the camera
            </button>
          ) : null}
        </Card>

        <ByHand onFound={go} />
      </div>
    </main>
  );
}

/**
 * The way in without a camera.
 *
 * A locked-down phone, a laptop with no camera, or plain http on a venue's LAN
 * all refuse `getUserMedia`. The slip prints the link in words underneath the
 * code for exactly this, so this box takes what is printed there.
 */
function ByHand({ onFound }: { onFound: (to: Destination) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const to = readDestination(text);
    if (!to) {
      setError('That does not look like a ballot link. It is the line under the code.');
      return;
    }
    setError('');
    onFound(to);
  };

  return (
    <Card>
      <h2>Or type the link</h2>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <form onSubmit={submit}>
        <Field label="The line printed under the code"
               help="The whole address, or just the two names from it.">
          <input name="ballot_link" value={text} autoComplete="off"
                 placeholder="demo-society/agm-2026"
                 onChange={(e) => { setText(e.target.value); setError(''); }} />
        </Field>
        <button type="submit" className="ghost" disabled={!text.trim()}>Open that ballot</button>
      </form>
    </Card>
  );
}
