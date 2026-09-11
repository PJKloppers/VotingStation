/**
 * Live results.
 *
 * The tally is never assembled from the events. A change on a vote table is
 * only a nudge to re-ask `ballot_results`, which stays the one place a count is
 * derived -- so a dropped event, a replayed one or an out-of-order one costs
 * nothing but a redundant refresh.
 *
 * A slow poll runs underneath regardless. Sockets die quietly on hotel wifi,
 * and a monitor left on a screen at the front of a room has to be right even
 * when nobody is watching it closely enough to notice it has gone stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import * as api from './api';
import { supabase } from './supabase';
import type { BallotResults } from './types';

/** Tables a vote can land in. Extend when a question type is added. */
const VOTE_TABLES = ['votes_yes_no', 'votes_highest_outright', 'votes_highest_x'] as const;

/** Several votes arrive together when a ballot is submitted; refresh once. */
const SETTLE_MS = 400;

/** The backstop, for when the socket is gone and nothing says so. */
const POLL_MS = 15000;

export type LiveStatus = 'connecting' | 'live' | 'polling';

export interface Live {
  results: BallotResults | null;
  error: string;
  status: LiveStatus;
  /** When the tally on screen was last read from the database. */
  updatedAt: Date | null;
  /** Votes seen since the page opened, for the "something is happening" pulse. */
  changes: number;
  refresh: () => void;
}

export function useLiveResults(ballotId: string): Live {
  const [results, setResults] = useState<BallotResults | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [changes, setChanges] = useState(0);

  // A refresh in flight must not be overtaken by the one that follows it.
  const inFlight = useRef(false);
  const queued = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) { queued.current = true; return; }
    inFlight.current = true;
    try {
      const answer = await api.ballotResults(ballotId);
      if (answer.ok) { setResults(answer); setUpdatedAt(new Date()); setError(''); }
      else setError(answer.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lost touch with the database.');
    } finally {
      inFlight.current = false;
      if (queued.current) { queued.current = false; void refresh(); }
    }
  }, [ballotId]);

  const nudge = useCallback(() => {
    setChanges((n) => n + 1);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => { void refresh(); }, SETTLE_MS);
  }, [refresh]);

  useEffect(() => {
    void refresh();

    let channel: RealtimeChannel | null = supabase.channel(`ballot:${ballotId}`);
    for (const table of VOTE_TABLES) {
      channel = channel!.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `ballot_id=eq.${ballotId}` },
        nudge,
      );
    }
    channel!.subscribe((state) => {
      // Anything other than a live subscription means the poll is carrying it.
      setStatus(state === 'SUBSCRIBED' ? 'live' : state === 'CLOSED' ? 'connecting' : 'polling');
    });

    const poll = setInterval(() => { void refresh(); }, POLL_MS);

    return () => {
      clearInterval(poll);
      if (settle.current) clearTimeout(settle.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [ballotId, nudge, refresh]);

  return { results, error, status, updatedAt, changes, refresh: () => void refresh() };
}
