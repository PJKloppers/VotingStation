import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://ukkgodlkxoyilyagtttj.supabase.co';
export const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Tv9rORiv-iZfpcRDLaSdjg_Dk6FiRcO';

/**
 * The organizer account the suite signs in as.
 *
 * Set TEST_EMAIL and TEST_PASSWORD, or point TEST_CREDENTIALS_FILE at a
 * two-line file holding the address and then the password. The default path is
 * outside the repository on purpose -- the credentials are not committed.
 */
export function credentials(): { email: string; password: string } {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  if (email && password) return { email, password };

  const file = process.env.TEST_CREDENTIALS_FILE
    ?? resolve(import.meta.dir, '../../../../user_test');
  if (!existsSync(file)) {
    throw new Error(
      `No test credentials. Set TEST_EMAIL and TEST_PASSWORD, or put them on two lines in ${file}.`,
    );
  }
  const [line1 = '', line2 = ''] = readFileSync(file, 'utf8').split('\n');
  return { email: line1.trim(), password: line2.trim() };
}

/** A client with no session: exactly what a voter's browser holds. */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * A second organizer, for proving one account cannot see another's work.
 * Same password, a `+isolation` address -- so the suite needs one secret, not
 * two, and the account is obviously a test account wherever it shows up.
 */
export async function otherOrganizerClient(): Promise<SupabaseClient> {
  const client = anonClient();
  const { email, password } = credentials();
  const [name = '', domain = ''] = email.split('@');
  const { error } = await client.auth.signInWithPassword({
    email: `${name}+isolation@${domain}`, password,
  });
  if (error) throw new Error(`Could not sign in as the second organizer: ${error.message}`);
  return client;
}

/** A client signed in as the organizer. */
export async function organizerClient(): Promise<SupabaseClient> {
  const client = anonClient();
  const { email, password } = credentials();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Could not sign in as ${email}: ${error.message}`);
  return client;
}

export const uniqueSlug = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
