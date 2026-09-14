import { createClient } from '@supabase/supabase-js';

/**
 * Both of these are public by design: the URL is a hostname and the
 * publishable key only ever grants the `anon` role, which row level security
 * and the function grants keep to the voter surface. The build inlines them,
 * so the deploy needs no secrets.
 */
export const SUPABASE_URL = process.env.SUPABASE_URL as string;
export const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY as string;

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'votingstation.auth',
    /*
     * OAuth comes back through PKCE, not the implicit flow.
     *
     * supabase-js still defaults to `implicit`, which hands the session back
     * in the URL *fragment* -- and the fragment is this app's router. The
     * return would arrive as a route reading `access_token=...`, drawing
     * "there is no page at ..." until the library cleared the hash out from
     * under it. PKCE puts a `?code=` in the query string instead, which
     * `useRoute` never looks at, so the route survives the round trip by
     * construction rather than by winning a race.
     */
    flowType: 'pkce',
    /*
     * Passkeys are behind a flag in the library: without it every passkey
     * method throws at call time rather than being absent, so there is nothing
     * to feature-detect against. The project has them enabled, with its
     * relying party set.
     *
     * Where they will and will not work is worth knowing: the relying party is
     * bound to one domain, so a passkey made on the app's own domain is not
     * offered on localhost or on the github.io address. That is WebAuthn doing
     * its job -- a passkey is tied to the site it was made for -- and it is
     * why the tests check the plumbing rather than the ceremony.
     */
    experimental: { passkey: true },
  },
});
