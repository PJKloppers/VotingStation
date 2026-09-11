/**
 * Carries a PIN from the front page to the ballot it opens.
 *
 * In memory and nowhere else: a PIN in the URL would sit in browser history,
 * and in storage it would outlive the session on a shared phone. The cost is
 * that a reload drops it and the voter types it again, which is the right way
 * round.
 */
let pending: { ballotId: string; pin: string } | null = null;

export function handOffPin(ballotId: string, pin: string): void {
  pending = { ballotId, pin };
}

/** Returns the PIN meant for this ballot, once. */
export function takePin(ballotId: string): string | null {
  if (!pending || pending.ballotId !== ballotId) return null;
  const { pin } = pending;
  pending = null;
  return pin;
}
