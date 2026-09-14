/**
 * The account itself, as opposed to what it owns.
 *
 * Small on purpose. An organizer's work is their organizations and ballots, and
 * those have their own pages; what is left over is the address they signed in
 * with, the way out, and the way out for good. Putting the last of those on the
 * dashboard would have meant a delete-everything button on the page an
 * organizer uses every day.
 */
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as api from '../lib/api';
import { signOut } from '../lib/auth';
import { navigate } from '../lib/router';
import type { Organization } from '../lib/types';
import { Banner, Card, Spinner } from '../components/ui';

export function Account({ session }: { session: Session }) {
  const email = session.user.email ?? '—';
  // Google gives an account no password of its own; saying which way in was
  // used saves an organizer wondering why there is nothing to change here.
  const google = session.user.app_metadata?.provider === 'google';

  return (
    <main className="narrow">
      <div className="stack">
        <div>
          <p className="eyebrow">Account</p>
          <h1>{email}</h1>
          {/* Only worth saying when it explains something: a Google account has
              no password of its own to change here. */}
          {google ? <p className="faint">Signed in with Google.</p> : null}
        </div>

        <Card>
          <h3>Sign out</h3>
          <p className="faint">
            Ends this session on this device. Your organizations and ballots are untouched.
          </p>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </Card>

        <DeleteAccount email={email} />
      </div>
    </main>
  );
}

/**
 * Closing the account, and everything it owns.
 *
 * What is about to go is counted first and named rather than described. "Your
 * data" is not a quantity; "two organizations and five ballots" is, and an
 * organizer who has forgotten what is in here deserves to be told before they
 * type their own address to confirm it.
 */
function DeleteAccount({ email }: { email: string }) {
  const [arming, setArming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [holdings, setHoldings] = useState<{ orgs: number; ballots: number } | null>(null);
  const [counting, setCounting] = useState(false);

  useEffect(() => {
    if (!arming) return;
    let live = true;
    setCounting(true);
    void (async () => {
      try {
        const orgs: Organization[] = await api.myOrganizations();
        const counts = await Promise.all(orgs.map((o) => api.ballotsForOrg(o.id)));
        if (live) setHoldings({
          orgs: orgs.length,
          ballots: counts.reduce((n, list) => n + list.length, 0),
        });
      } catch {
        if (live) setHoldings(null);   // the sentence below copes with not knowing
      } finally {
        if (live) setCounting(false);
      }
    })();
    return () => { live = false; };
  }, [arming]);

  const remove = async () => {
    setBusy(true); setError('');
    try {
      await api.deleteAccount();
      // The session is a token for a user that no longer exists. Dropping it
      // here means the app does not spend the next minute failing every call
      // with an error nobody can act on.
      await signOut();
      navigate('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the account.');
      setBusy(false);
    }
  };

  const what = () => {
    if (counting) return 'everything it owns';
    if (!holdings) return 'every organization on it, and every ballot in those';
    if (holdings.orgs === 0) return 'nothing else — there are no organizations on it';
    const orgs = holdings.orgs === 1 ? '1 organization' : `${holdings.orgs} organizations`;
    const ballots = holdings.ballots === 1 ? '1 ballot' : `${holdings.ballots} ballots`;
    return `${orgs} and ${ballots}`;
  };

  return (
    <Card>
      <h3>Delete this account</h3>

      {!arming ? (
        <>
          <p className="faint">
            Takes your organizations with it, and every ballot, PIN and vote in them.
          </p>
          <button className="danger" onClick={() => setArming(true)}>Delete my account</button>
        </>
      ) : (
        <div className="ballot-confirm">
          <p className="faint">
            Deleting this account takes {what()}, every PIN and vote on them, and
            any marks you uploaded. There is no undo, and nobody can restore it
            for you afterwards.
          </p>
          {counting ? <Spinner label="Counting what is on it" /> : null}
          {error ? <Banner kind="error">{error}</Banner> : null}
          <div className="row">
            <input
              className="grow"
              name="confirm_account"
              autoFocus
              autoComplete="off"
              placeholder={`Type "${email}" to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button className="ghost small"
                    onClick={() => { setArming(false); setTyped(''); setError(''); }}>
              Cancel
            </button>
            <button className="btn-danger solid small"
                    disabled={busy || counting || typed.trim() !== email.trim()}
                    onClick={() => void remove()}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
