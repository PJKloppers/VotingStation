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
let awaitingOAuth = returned.has('code');
const failedReturn = returned.get('error_description') ?? returned.get('error') ?? '';

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

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setReady(true);
      // a Google sign-in returns to the bare page, because the redirect URL
      // has to be one fixed string on the allow-list. This is where it
      // becomes a route -- the same place the password form goes.
      if (event === 'SIGNED_IN' && awaitingOAuth) {
        awaitingOAuth = false;
        navigate('/admin');
      }
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
