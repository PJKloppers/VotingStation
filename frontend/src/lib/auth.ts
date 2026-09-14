import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { appBase, navigate } from './router';
import { supabase } from './supabase';

/**
 * Where the provider sends the browser back to.
 *
 * Read off the address bar rather than compiled in, so the same build works
 * at the deploy's `/VotingStation/` prefix, at a domain root, and on
 * localhost. No fragment: the route is decided once the code has been
 * exchanged, not by whichever page started the sign-in.
 *
 * Whatever this returns has to be in the project's Redirect URLs allow-list,
 * which is a dashboard setting.
 */
export function oauthReturnUrl(): string {
  return appBase();
}

/**
 * What this page load is, read before anything can rewrite the address bar.
 *
 * `code` means the provider sent us back and the library is exchanging it;
 * the session arrives later, as a SIGNED_IN event. `error` means it refused
 * -- most often because the redirect URL is not on the allow-list -- and
 * there is no event coming, so the message has to be carried to the sign-in
 * page by hand.
 */
const returned = new URLSearchParams(window.location.search);
/**
 * A code in the query means this page load is a return: from Google, or from a
 * link in an email. Somewhere a session is about to exist, and when it does
 * this load owes the organizer a route.
 */
let owedRoute = returned.has('code');
const failedReturn = returned.get('error_description') ?? returned.get('error') ?? '';

/**
 * Whether the code being exchanged came out of a password-reset email.
 *
 * Carried in the query string rather than the fragment, and that is forced:
 * the return URL has to be one the project's allow-list matches, PKCE appends
 * its `?code=` to whatever that URL is, and a `#/reset-password` on the end
 * would put the code *inside* the fragment where the library never looks for
 * it. A query parameter sits beside the code instead of swallowing it.
 *
 * Read here, before anything can rewrite the address bar, and then taken out
 * of it -- a reset link is a credential, and it has no business staying in the
 * history of a shared machine.
 */
const recovering = returned.get('flow') === 'recovery';

if (recovering) {
  const url = new URL(window.location.href);
  url.searchParams.delete('flow');
  window.history.replaceState(window.history.state, '', url.toString());
}

if (failedReturn) {
  // strip it, and land on the page that can say what went wrong: a failed
  // return would otherwise drop the organizer on the voter's front page with
  // nothing to read.
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '/signin';
  window.history.replaceState(window.history.state, '', url.toString());
}

/** What a failed return said, for the sign-in page to show. */
export function oauthError(): string {
  return failedReturn;
}


/**
 * Sends a returning organizer where the link they followed meant them to go.
 *
 * Driven by the session existing, not by which event announced it, and that is
 * the whole point of it. It used to wait for `SIGNED_IN`, which is one of
 * several ways a session can turn up: the code is exchanged while the page is
 * still booting, so if that finishes before React has subscribed the event is
 * simply gone, and a later subscriber is greeted with `INITIAL_SESSION`
 * instead. The organizer then landed on the front page, signed in, with no
 * sign of the page they had asked for -- which is exactly what a reset link
 * did.
 *
 * A reset link wants the password form rather than the dashboard, and it is
 * told apart by what the link asked for rather than by the event, because
 * PASSWORD_RECOVERY is not raised on the PKCE path -- the exchange reports
 * itself as an ordinary sign-in.
 *
 * Runs once: `owedRoute` is cleared before navigating, so a session refreshing
 * an hour later does not move anybody off the page they are reading.
 */
function settleReturn(session: Session | null): void {
  if (!session || !owedRoute) return;
  owedRoute = false;
  navigate(recovering ? '/reset-password' : '/admin');
}

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setSession(data.session);
      setReady(true);
      settleReturn(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
      settleReturn(next);
    });
    return () => { live = false; sub.subscription.unsubscribe(); };
  }, []);

  return { session, ready };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Hands the browser to Google. Nothing after this runs: the page leaves. */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: oauthReturnUrl() },
  });
  if (error) throw new Error(error.message);
}

export async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  return { needsConfirmation: !data.session };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/**
 * Sends the password-reset letter.
 *
 * `flow=recovery` rides along so the app knows, when the browser comes back,
 * that the organizer is here to choose a password rather than to be dropped on
 * their dashboard.
 *
 * It resolves the same whether or not the address has an account. Telling a
 * stranger which addresses are registered is the one thing this form could
 * leak, so it does not: the page says the same sentence either way.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${appBase()}?flow=recovery`,
  });
  if (error) throw new Error(error.message);
}

/** Sets a new password on the session the reset link created. */
export async function setPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------- passkeys */

/** One passkey on the account, as the server lists it. */
export interface Passkey {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
}

/**
 * Whether this browser can make a passkey at all.
 *
 * Two things have to be true, and they fail differently. `PublicKeyCredential`
 * missing means the browser has no WebAuthn -- nothing to offer. A page served
 * without a secure context has the API but every call refuses, which would
 * read to an organizer as the button being broken.
 */
export function passkeysPossible(): boolean {
  return typeof window !== 'undefined'
    && 'PublicKeyCredential' in window
    && window.isSecureContext;
}

export async function listPasskeys(): Promise<Passkey[]> {
  const { data, error } = await supabase.auth.passkey.list();
  if (error) throw new Error(error.message);
  return (data ?? []) as Passkey[];
}

/**
 * Registers a passkey against the signed-in account.
 *
 * The library runs the whole ceremony: it asks the server for a challenge,
 * hands it to the browser, and posts the credential back. What the organizer
 * sees is their own device asking for a fingerprint or a PIN.
 */
export async function addPasskey(): Promise<void> {
  const { error } = await supabase.auth.registerPasskey();
  if (error) throw new Error(error.message);
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  const { error } = await supabase.auth.passkey.update({ passkeyId: id, friendlyName: name });
  if (error) throw new Error(error.message);
}

export async function removePasskey(id: string): Promise<void> {
  const { error } = await supabase.auth.passkey.delete({ passkeyId: id });
  if (error) throw new Error(error.message);
}

/** Signs in with a passkey, with no address or password typed at all. */
export async function signInWithPasskey(): Promise<void> {
  const { error } = await supabase.auth.signInWithPasskey();
  if (error) throw new Error(error.message);
}
