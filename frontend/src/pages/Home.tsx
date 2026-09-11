/**
 * The front page.
 *
 * A voter arrives holding a PIN and nothing else, so that is all the page asks
 * for. A PIN is unique per ballot rather than globally, so it is looked up: one
 * match goes straight through, several ask which, none says so.
 */
import { useCallback, useState } from 'react';
import * as api from '../lib/api';
import { handOffPin } from '../lib/handoff';
import { navigate } from '../lib/router';
import type { PinMatch } from '../lib/types';
import { Banner, Card, Pill } from '../components/ui';

export function Home() {
  return (
    <main className="narrow">
      <div className="stack">
        <header style={{ maxWidth: '40ch' }}>
          <p className="eyebrow">Token voting</p>
          <h1>Enter your PIN to vote.</h1>
        </header>
        <PinGate />
      </div>
    </main>
  );
}

function PinGate() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<PinMatch[] | null>(null);

  const open = useCallback((match: PinMatch, thePin: string) => {
    handOffPin(match.ballot_id, thePin);
    navigate(`/vote/${match.ballot_id}`);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setChoices(null);
    try {
      const answer = await api.findBallotsForPin(pin);
      if (!answer.ok) { setError(answer.error); return; }

      // One ballot is the ordinary case: go, without asking anything.
      if (answer.ballots.length === 1) open(answer.ballots[0]!, pin);
      else setChoices(answer.ballots);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <p className="muted">
        Your organizer issued you a six-digit PIN. It is the only thing you need.
      </p>
      {error ? <Banner kind="error">{error}</Banner> : null}

      <form onSubmit={submit} style={{ marginTop: 14 }}>
        <input
          className="pin-entry"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          name="pin"
          aria-label="Your six-digit PIN"
          placeholder="000000"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 6));
            setChoices(null); setError('');
          }}
        />
        <button type="submit" className="primary block" style={{ marginTop: 14 }}
                disabled={busy || pin.length !== 6}>
          {busy ? 'Checking…' : 'Open my ballot'}
        </button>
      </form>

      {choices ? (
        <div style={{ marginTop: 18 }}>
          <p className="faint">
            That PIN opens more than one ballot. Which one are you voting on?
          </p>
          {choices.map((c) => (
            <button key={c.ballot_id} className="lobby-item" onClick={() => open(c, pin)}>
              {api.logoUrl(c.org_logo_path)
                ? <img className="ballot-mark small" src={api.logoUrl(c.org_logo_path)!} alt="" />
                : null}
              <span className="lobby-body">
                <span className="lobby-title">{c.title}</span>
                <span className="faint" style={{ display: 'block' }}>{c.org_name}</span>
              </span>
              <Pill tone={c.status === 'live' ? 'live' : 'closed'}>{c.status}</Pill>
            </button>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
