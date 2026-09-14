/**
 * Choosing a new password, at the end of a reset link.
 *
 * The link signs the organizer in before it gets here -- that is what the code
 * in the address bar was for -- so this page does not ask who they are. It asks
 * for one thing, twice, and then sends them on.
 *
 * Reached without a session it says so plainly rather than showing a form that
 * cannot work. That happens more than it sounds: a reset link is used once,
 * and the second tap on the same message in a mail app arrives here with
 * nothing behind it.
 */
import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { setPassword } from '../lib/auth';
import { href, navigate } from '../lib/router';
import { Banner, Card, Field } from '../components/ui';

/** What the database will accept, so the page can say it before the server does. */
const MIN_LENGTH = 6;

export function ResetPassword({ session }: { session: Session | null }) {
  const [password, setPasswordValue] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (!session) {
    return (
      <main className="narrow">
        <Card>
          <p className="eyebrow">Reset password</p>
          <h1>That link has already been used</h1>
          <p className="lede">
            A reset link works once. Ask for another and use the newest message.
          </p>
          <a className="btn btn-primary" href={href('/signin')}>Back to signing in</a>
        </Card>
      </main>
    );
  }

  if (done) {
    return (
      <main className="narrow">
        <Card>
          <p className="eyebrow">Reset password</p>
          <h1>That is your password now</h1>
          <p className="lede">
            You are signed in on this device. The old password no longer works
            anywhere.
          </p>
          <button className="primary" onClick={() => navigate('/admin')}>
            Go to your ballots
          </button>
        </Card>
      </main>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = again.length > 0 && again !== password;
  const ready = password.length >= MIN_LENGTH && again === password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await setPassword(password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set that password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <Card>
        <p className="eyebrow">Reset password</p>
        <h1>Choose a new password</h1>
        <p className="lede">
          For <span className="mono">{session.user.email}</span>. This replaces the
          old one everywhere.
        </p>

        {error ? <Banner kind="error">{error}</Banner> : null}

        <form onSubmit={submit}>
          <Field label="New password" help={`At least ${MIN_LENGTH} characters.`}>
            <input type="password" name="new_password" autoComplete="new-password"
                   value={password}
                   onChange={(e) => setPasswordValue(e.target.value)} />
          </Field>
          {tooShort
            ? <p className="faint">A few more characters.</p>
            : null}

          <Field label="Again">
            <input type="password" name="new_password_again" autoComplete="new-password"
                   value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          {mismatch
            ? <p className="faint">Those two do not match yet.</p>
            : null}

          <button type="submit" className="primary block" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Set this password'}
          </button>
        </form>
      </Card>
    </main>
  );
}
