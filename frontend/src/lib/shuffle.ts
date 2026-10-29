/**
 * A fixed shuffle: the same items and seed always give the same order, and
 * the order says nothing about the items themselves.
 *
 * The live monitor uses it when the counts are hidden: a list sorted by votes
 * would still show who is ahead. One seed per page load keeps the order still
 * while votes arrive, so nobody can read a change of place as a change of count.
 */
export function shuffled<T>(items: readonly T[], seed: string, key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, rank: hash(`${seed}:${key(item)}`) }))
    .sort((a, b) => a.rank - b.rank || (key(a.item) < key(b.item) ? -1 : 1))
    .map((x) => x.item);
}

/** FNV-1a, 32 bit: quick, and spread well enough for ordering a list. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seed for one page load. */
export const newSeed = () => Math.random().toString(36).slice(2);
