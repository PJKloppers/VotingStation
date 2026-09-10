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
  },
});
