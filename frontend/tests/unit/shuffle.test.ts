import { describe, expect, test } from 'bun:test';
import { shuffled } from '../../src/lib/shuffle';

const people = Array.from({ length: 12 }, (_, i) => ({ id: `id-${i}`, votes: 12 - i }));
const ids = (xs: typeof people) => xs.map((p) => p.id);

describe('shuffled', () => {
  test('keeps every item, once', () => {
    const out = shuffled(people, 'seed', (p) => p.id);
    expect(ids(out).sort()).toEqual(ids(people).sort());
  });

  test('the same seed gives the same order, whatever order the items arrive in', () => {
    const a = shuffled(people, 'abc', (p) => p.id);
    const b = shuffled([...people].reverse(), 'abc', (p) => p.id);
    expect(ids(a)).toEqual(ids(b));
  });

  test('the order does not follow the votes, and changes with the seed', () => {
    const a = ids(shuffled(people, 'one', (p) => p.id));
    const b = ids(shuffled(people, 'two', (p) => p.id));
    expect(a).not.toEqual(ids(people));
    expect(a).not.toEqual(b);
  });

  test('a new vote does not move anyone', () => {
    const before = ids(shuffled(people, 'room', (p) => p.id));
    const after = ids(shuffled(people.map((p, i) => (i === 5 ? { ...p, votes: 99 } : p))
      .sort((x, y) => y.votes - x.votes), 'room', (p) => p.id));
    expect(after).toEqual(before);
  });
});
