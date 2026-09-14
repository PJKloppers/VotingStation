/**
 * The account itself, as opposed to what it owns.
 *
 * Small on purpose. An organizer's work is their organizations and ballots, and
 * those have their own pages; what is left over is the address they signed in
 * with, the way out, and the way out for good. Putting the last of those on the
 * dashboard would have meant a delete-everything button on the page an
 * organizer uses every day.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as api from '../lib/api';
import {
  addPasskey, listPasskeys, passkeysPossible, removePasskey, renamePasskey, signOut,
  type Passkey,
} from '../lib/auth';
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
          {/* An address is one unbroken token as far as the browser is
              concerned, so a long one runs straight off the side rather than
              wrapping. It is told it may break anywhere. */}
          <h1 className="account-email">{email}</h1>
          {/* Only worth saying when it explains something: a Google account has
              no password of its own to change here. */}
          {google ? <p className="faint">Signed in with Google.</p> : null}
        </div>

        <Passkeys />

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

/**
 * The passkeys on this account, and the button that adds one.
 *
 * A passkey is this device proving it is this device -- a fingerprint, a face,
 * a screen lock -- instead of a password typed into a phone at the back of a
 * hall. Adding one does not take the password away; it is another way in, and
 * an organizer keeps whichever they like.
 *
 * The list is the honest part of this. A passkey lives on a device, and an
 * account with three of them and no idea which is which is worse than an
 * account with none, so each says when it was made and when it was last used,
 * and can be named.
 */
function Passkeys() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = passkeysPossible();

  const load = useCallback(async () => {
    try {
      setKeys(await listPasskeys());
      setError('');
    } catch (e) {
      // A project without passkeys turned on answers every one of these calls
      // with a refusal. Saying so beats an empty list that looks like a bug.
      setError(e instanceof Error ? e.message : 'Could not read your passkeys.');
      setKeys([]);
    }
  }, []);

  useEffect(() => { if (supported) void load(); }, [supported, load]);

  const add = async () => {
    setBusy(true); setError('');
    try {
      await addPasskey();
      await load();
    } catch (e) {
      const said = e instanceof Error ? e.message : 'Could not add a passkey.';
      // The browser says "NotAllowedError" when somebody dismisses the prompt,
      // which is not an error worth showing as one.
      setError(/notallowed|abort/i.test(said)
        ? '' : said);
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <Card>
        <h3>Passkeys</h3>
        <p className="faint">
          This browser cannot make one — it needs WebAuthn and a secure (https)
          connection. Open the app on its own address and it will offer them.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h3>Passkeys</h3>
      <p className="faint">
        Sign in with the fingerprint, face or screen lock this device already
        uses, instead of typing a password. Your password keeps working.
      </p>

      {error ? <Banner kind="error">{error}</Banner> : null}

      {keys === null ? <Spinner label="Reading your passkeys" /> : null}

      {keys?.map((key) => (
        <div key={key.id} className="row" style={{ marginBottom: 8 }}>
          <input className="grow" name="passkey_name"
                 defaultValue={key.friendly_name ?? 'Unnamed passkey'}
                 onBlur={(e) => {
                   const next = e.target.value.trim();
                   if (next && next !== key.friendly_name) {
                     void renamePasskey(key.id, next).then(load).catch(() => {});
                   }
                 }} />
          <span className="faint">
            {key.last_used_at
              ? `used ${new Date(key.last_used_at).toLocaleDateString()}`
              : `added ${new Date(key.created_at).toLocaleDateString()}`}
          </span>
          <button className="danger small"
                  onClick={() => {
                    if (!confirm('Remove this passkey? The device it is on can no longer sign in with it.')) return;
                    void removePasskey(key.id).then(load).catch(
                      (e) => setError(e instanceof Error ? e.message : 'Could not remove it.'));
                  }}>
            Remove
          </button>
        </div>
      ))}

      {keys?.length === 0 ? <p className="faint">No passkeys on this account yet.</p> : null}

      <button className="ghost" disabled={busy} onClick={() => void add()}>
        {busy ? 'Waiting for your device…' : 'Add a passkey'}
      </button>
    </Card>
  );
}
