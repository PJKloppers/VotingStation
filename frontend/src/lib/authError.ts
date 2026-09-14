/**
 * Turning a sign-in refusal into something a person can act on.
 *
 * Its own module, with no Supabase client behind it, so the unit tests can
 * reach it: importing `auth.ts` drags in a client that wants its URL and key
 * injected at build time, which offline tests do not have.
 */
/**
 * A sentence a person can act on, for the handful of sign-in failures that
 * have one. Everything else is passed through as the server said it.
 *
 * The clock one is worth naming because the message is otherwise baffling and
 * the cause is never where you would look. A JWT carries the moment it was
 * issued, and whoever checks it compares that against their own clock: if the
 * checker's clock is behind, a token minted a second ago reads as one minted
 * in the future, and it is refused. On a Google sign-in there are three clocks
 * involved -- Google's, the auth server's and the device's -- and the message
 * does not say which of them is wrong.
 *
 * Usually it is transient and pressing the button again works. When it is not,
 * the device's own clock is the one the person can actually fix.
 */
export function explainAuthError(raw: string): string {
  if (/issued at future|issued in the future|clock|skew/i.test(raw)) {
    return 'Something\u2019s clock is out of step, so the sign-in token looked as '
      + 'though it came from the future and was refused. Try again \u2014 it is '
      + 'usually momentary. If it keeps happening, check that this device\u2019s '
      + 'clock is set automatically and is right to the second.';
  }
  if (/redirect|not allowed|invalid request/i.test(raw)) {
    return 'The address this app asked to be sent back to is not on the '
      + 'project\u2019s allow-list, so the provider refused to return here.';
  }
  return raw;
}
