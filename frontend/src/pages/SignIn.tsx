import { useState } from 'react';
import { oauthError, signIn, signInWithGoogle, signUp } from '../lib/auth';
import { navigate } from '../lib/router';
import { Banner, Card, Field } from '../components/ui';

/** Google's mark, at the size and in the colours their guidance fixes. */
function GoogleMark() {
  return (
    <svg className="g" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#ea4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285f4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#fbbc05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34a853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // a Google sign-in that never got as far as a session left its reason in the
  // address bar, and the page it came back to is this one.
  const [error, setError] = useState(oauthError());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      if (mode === 'in') {
        await signIn(email, password);
        navigate('/admin');
      } else {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) setNotice('Check your inbox to confirm the address, then sign in.');
        else navigate('/admin');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await signInWithGoogle();
      // the page is leaving for Google; `busy` stays on so nothing is pressed twice.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach Google.');
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <Card>
        <p className="eyebrow">Organizers</p>
        <h1>{mode === 'in' ? 'Sign in' : 'Create an account'}</h1>
        <p className="lede">
          You need an account to set up a ballot. Voters never do — they only need a PIN.
        </p>

        {error ? <Banner kind="error">{error}</Banner> : null}
        {notice ? <Banner kind="good">{notice}</Banner> : null}

        <form onSubmit={submit} style={{ marginTop: 18 }}>
          <Field label="Email">
            <input type="email" required autoComplete="email" name="email"
                   value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <input type="password" required minLength={8} name="password"
                   autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button type="submit" className="primary block" disabled={busy}>
            {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="or">or</p>

        <button type="button" className="google block" disabled={busy} onClick={google}>
          <GoogleMark />
          {mode === 'in' ? 'Sign in with Google' : 'Sign up with Google'}
        </button>

        <button className="ghost block" style={{ marginTop: 10 }}
                onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
          {mode === 'in' ? 'I need an account' : 'I already have an account'}
        </button>
      </Card>
    </main>
  );
}
