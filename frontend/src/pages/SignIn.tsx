import { useState } from 'react';
import { signIn, signUp } from '../lib/auth';
import { navigate } from '../lib/router';
import { Banner, Card, Field } from '../components/ui';

export function SignIn() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
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

        <button className="ghost block" style={{ marginTop: 10 }}
                onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
          {mode === 'in' ? 'I need an account' : 'I already have an account'}
        </button>
      </Card>
    </main>
  );
}
