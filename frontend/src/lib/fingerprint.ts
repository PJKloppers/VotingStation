/**
 * A per-browser id, sent with every PIN attempt so the lock-out counts one
 * device's guesses rather than the whole meeting's. It is not a security
 * boundary -- clearing storage resets it -- it is there so that one voter
 * fat-fingering their PIN cannot lock out the room, and so that a script
 * hammering PINs has to work at it.
 */
const KEY = 'votingstation.fp';

export function fingerprint(): string {
  try {
    let value = localStorage.getItem(KEY);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(KEY, value);
    }
    return value;
  } catch {
    return 'anon';
  }
}
