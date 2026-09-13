/**
 * Keeping a voter's page current without them doing anything.
 *
 * The chair opens a gate on their own device; the phones in the room have to
 * find out. They are told, rather than asking: a gate moving is an update to a
 * question row, and a published ballot's questions are already readable, so
 * Realtime can push it.
 *
 * Three things underneath that, because a room is a hostile place for a socket:
 *
 *   - a slow poll, in case the socket is gone and nothing said so;
 *   - a refresh when the tab comes back, because a phone that was in a pocket
 *     has a socket that died quietly and a screen that is minutes stale;
 *   - a refresh when the network returns.
 *
 * None of it is the tally -- this only ever says "ask again", and voter_state
 * remains the single thing that decides what a voter may see.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Question tables. Extend when a type is added. */
const QUESTION_TABLES = [
  'questions_yes_no',
  'questions_highest_outright',
  'questions_highest_x',
] as const;

/** A chair opening several gates at once should cost one refresh, not four. */
const SETTLE_MS = 250;

/** The backstop, for when the socket is gone and nothing says so. */
export const DEFAULT_BACKSTOP_MS = 20_000;

export function useBallotWatch(
  ballotId: string,
  refresh: () => void,
  { backstopMs = DEFAULT_BACKSTOP_MS, enabled = true } = {},
): void {
  // Kept in a ref so a changing callback does not tear the socket down and
  // build it again on every render.
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudge = useCallback(() => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => latest.current(), SETTLE_MS);
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let channel: RealtimeChannel | null = supabase.channel(`watch:${ballotId}`);
    for (const table of QUESTION_TABLES) {
      channel = channel!.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `ballot_id=eq.${ballotId}` },
        nudge,
      );
    }
    // The ballot itself closing, or being reopened.
    channel = channel!.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'ballots', filter: `id=eq.${ballotId}` },
      nudge,
    );
    /*
     * Catch up the moment the socket is listening.
     *
     * Subscribing takes a second or two, and anything that happens in that
     * window is simply not delivered -- a voter whose page had just loaded
     * would sit on a stale screen until the backstop, twenty seconds later.
     * One refresh on SUBSCRIBED closes the gap, and it is also what recovers a
     * socket that dropped and came back.
     */
    channel!.subscribe((status) => {
      if (status === 'SUBSCRIBED') latest.current();
    });

    const poll = setInterval(() => latest.current(), backstopMs);
    const onWake = () => { if (document.visibilityState === 'visible') latest.current(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);

    return () => {
      clearInterval(poll);
      if (settle.current) clearTimeout(settle.current);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [ballotId, backstopMs, enabled, nudge]);
}
