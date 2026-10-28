import { describe, expect, test } from 'bun:test';
import { bulkProblem, RACE_DEFAULTS } from '../../src/lib/races';

const row = (prompt: string, pool = 'p1', majority = true) => ({ prompt, pool, majority });

describe('bulk races: what stops the button', () => {
  test('every row needs a question and a pool', () => {
    expect(bulkProblem([])).toBe('Add a race first.');
    expect(bulkProblem([row('Chair'), row('  ')])).toBe('Race 2 needs a question.');
    expect(bulkProblem([row('Chair'), row('Secretary', '')])).toBe('Race 2 needs a pool.');
  });

  test('the same question twice is caught, whatever its case or spacing', () => {
    expect(bulkProblem([row('Chair'), row(' chair ')])).toBe('Race 2 asks the same as an earlier one.');
  });

  test('a full set of rows is ready', () => {
    expect(bulkProblem([row('Chair'), row('Secretary', 'p2', false)])).toBeNull();
  });

  test('every race gets the open defaults: nominate anyone, pick anyone', () => {
    expect(RACE_DEFAULTS).toEqual({
      nominate_max: null, nominate_threshold: 1, pick_min: 1, pick_max: null, allow_abstain: false,
    });
  });
});
