/**
 * What an account can actually be signed into with.
 *
 * Its own module, with no Supabase client behind it, so the unit tests can
 * reach it: importing `auth.ts` drags in a client that wants its URL and key
 * injected at build time, which offline tests do not have.
 *
 * The question this answers is narrow and worth stating plainly. An account
 * made with Google has no password, so offering to change one is offering
 * something that does not exist -- and the form would fail on the old password
 * every time, with no way for the organizer to know why.
 */

/** The shape we need off a Supabase user, and no more of it than that. */
export interface AccountIdentities {
  identities?: Array<{ provider: string }> | null;
  app_metadata?: { provider?: string; providers?: string[] } | null;
}

/** Supabase's name for the email-and-password identity. */
const PASSWORD = 'email';

/**
 * Every way this account can be signed into, lower-cased and deduplicated.
 *
 * `identities` is the authoritative list and the only one that keeps up when a
 * provider is linked or unlinked. `app_metadata` is consulted only when it is
 * missing, which happens on a session restored from storage by an older build.
 */
export function providersOn(user: AccountIdentities): string[] {
  const listed = (user.identities ?? []).map((i) => i.provider);
  const fallback = user.app_metadata?.providers
    ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []);
  const all = (listed.length > 0 ? listed : fallback).map((p) => p.toLowerCase());
  return [...new Set(all)];
}

/**
 * Whether there is a password on this account to change.
 *
 * An account can hold several identities at once -- signed up with a password,
 * linked Google later -- and one of them being Google does not take the
 * password away. So this asks whether the password identity is present, not
 * whether it is the only one.
 */
export function hasPassword(user: AccountIdentities): boolean {
  return providersOn(user).includes(PASSWORD);
}

/** The other ways in, for a sentence explaining why there is no password. */
export function thirdPartyProviders(user: AccountIdentities): string[] {
  return providersOn(user).filter((p) => p !== PASSWORD);
}

/** "Google", "Google and GitHub", "Google, GitHub and Apple". */
export function readableProviders(user: AccountIdentities): string {
  const names = thirdPartyProviders(user)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
