import { describe, expect, test } from 'bun:test';
import { minimumPicks, previewDrop, selectionError, thresholdRule } from '../../src/lib/rules';
import { slugify } from '../../src/lib/slug';
import type { LobbyQuestion, RecursionRoundTally } from '../../src/lib/types';

function question(over: Partial<LobbyQuestion>): LobbyQuestion {
  return {
    id: 'q', type: 'yes_no', prompt: 'Q', description: '', gate_open: true,
    config: {}, options: [], voted: false, previous: null, ...over,
  };
}

describe('yes / no', () => {
  const q = question({
    type: 'yes_no',
    config: { yes_label: 'Yes', no_label: 'No', allow_abstain: false, abstain_label: 'Abstain',
              pass_num: 1, pass_den: 2, threshold_strict: true },
  });

  test('takes a yes or a no', () => {
    expect(selectionError(q, ['yes'])).toBeNull();
    expect(selectionError(q, ['no'])).toBeNull();
  });

  test('refuses nothing at all', () => {
    expect(selectionError(q, [])).toBe('Choose an answer.');
  });

  test('refuses an abstention the question does not allow', () => {
    expect(selectionError(q, ['abstain'])).toBe('This question does not allow abstentions.');
  });

  test('allows an abstention when the question does', () => {
    const open = question({ ...q, config: { ...(q.config as object), allow_abstain: true } });
    expect(selectionError(open, ['abstain'])).toBeNull();
  });

  test('refuses a value that is not one of the three', () => {
    expect(selectionError(q, ['maybe'])).toBe('Choose an answer.');
  });
});

describe('highest outright', () => {
  const q = question({
    type: 'highest_outright',
    options: [
      { id: 'a', label: 'Ann', description: '' },
      { id: 'b', label: 'Ben', description: '' },
    ],
    config: { require_majority: false, allow_abstain: false, abstain_label: 'Abstain' },
  });

  test('takes exactly one live option', () => {
    expect(selectionError(q, ['a'])).toBeNull();
  });

  test('refuses two', () => {
    expect(selectionError(q, ['a', 'b'])).toBe('Choose one option.');
  });

  test('refuses an option that is not on the question', () => {
    expect(selectionError(q, ['z'])).toBe('That option is not available.');
  });

  test('refuses an abstention unless the question allows it', () => {
    expect(selectionError(q, ['abstain'])).toBe('This question does not allow abstentions.');
    const open = question({ ...q, config: { ...(q.config as object), allow_abstain: true } });
    expect(selectionError(open, ['abstain'])).toBeNull();
  });
});

describe('highest X options', () => {
  const q = question({
    type: 'highest_x',
    options: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase(), description: '' })),
    config: { select_min: 2, select_max: 3, winner_count: 3 },
  });

  test('takes a selection inside the range', () => {
    expect(selectionError(q, ['a', 'b'])).toBeNull();
    expect(selectionError(q, ['a', 'b', 'c'])).toBeNull();
  });

  test('refuses too few', () => {
    expect(selectionError(q, ['a'])).toBe('Choose at least 2.');
  });

  test('refuses too many', () => {
    expect(selectionError(q, ['a', 'b', 'c', 'd'])).toBe('Choose at most 3.');
  });

  test('ignores duplicates rather than counting them twice', () => {
    expect(selectionError(q, ['a', 'a', 'b'])).toBeNull();
    expect(selectionError(q, ['a', 'a'])).toBe('Choose at least 2.');
  });

  test('ignores an option that is not on the question', () => {
    expect(selectionError(q, ['a', 'b', 'zzz'])).toBeNull();
    expect(selectionError(q, ['a', 'zzz'])).toBe('Choose at least 2.');
  });

  test('a minimum of zero still needs one pick', () => {
    expect(minimumPicks({ select_min: 0, select_max: 3, winner_count: 1 })).toBe(1);
    const loose = question({ ...q, config: { select_min: 0, select_max: 3, winner_count: 1 } });
    expect(selectionError(loose, [])).toBe('Choose at least 1.');
  });
});

describe('the threshold sentence', () => {
  test('names a simple majority as one', () => {
    expect(thresholdRule('1/2', true)).toBe('simple majority');
  });
  test('spells out anything else', () => {
    expect(thresholdRule('2/3', false)).toBe('at least 2/3 of the decisive votes');
    expect(thresholdRule('2/3', true)).toBe('more than 2/3 of the decisive votes');
  });
});

describe('slugs', () => {
  test('makes a link-safe name', () => {
    expect(slugify('Annual General Meeting 2026')).toBe('annual-general-meeting-2026');
  });
  test('trims punctuation from both ends', () => {
    expect(slugify('  --Hello, World!--  ')).toBe('hello-world');
  });
  test('falls back when nothing usable is left', () => {
    expect(slugify('!!!')).toBe('ballot');
    expect(slugify('ab')).toBe('ballot');
  });
  test('never ends on a dash after the length cut', () => {
    expect(slugify('x'.repeat(47) + ' y')).not.toMatch(/-$/);
  });
});

describe('recursion filter', () => {
  const base = question({
    type: 'recursion_filter',
    options: [
      { id: 'a', label: 'Ann', description: '' },
      { id: 'b', label: 'Ben', description: '' },
      { id: 'c', label: 'Cyd', description: '' },
    ],
    config: { round: 0, kind: 'nomination', pick_min: 1, pick_max: 2,
              allow_abstain: false, abstain_label: 'Abstain' },
  });

  test('takes up to the most a round allows', () => {
    expect(selectionError(base, ['a'])).toBeNull();
    expect(selectionError(base, ['a', 'b'])).toBeNull();
    expect(selectionError(base, ['a', 'b', 'c'])).toBe('Choose at most 2.');
  });

  test('refuses nobody at all', () => {
    expect(selectionError(base, [])).toBe('Choose someone.');
  });

  test('ignores someone who is not in this round', () => {
    expect(selectionError(base, ['gone'])).toBe('Choose someone.');
  });

  test('holds a round to its least', () => {
    const two = question({ ...base, config: { ...(base.config as object), kind: 'elimination', round: 2, pick_min: 2 } });
    expect(selectionError(two, ['a'])).toBe('Choose at least 2.');
    expect(selectionError(two, ['a', 'c'])).toBeNull();
  });

  test('abstains only when the question allows it', () => {
    expect(selectionError(base, ['abstain'])).toBe('This question does not allow abstentions.');
    const open = question({ ...base, config: { ...(base.config as object), allow_abstain: true } });
    expect(selectionError(open, ['abstain'])).toBeNull();
  });
});

/* ------------------------------------------------- the drop-off preview */

describe('previewDrop: how people drop out of a round', () => {
  // a round with seats open and these counts; `elect` are those with a majority
  const round = (votes: Record<string, number>, over: Partial<RecursionRoundTally> = {}): RecursionRoundTally => ({
    round: 2, kind: 'elimination', gate_open: false, opened: true, settled: false,
    voters: 30, ballots: 30, abstain: 0, pick_min: 1, pick_max: 5, threshold: null,
    seats: 10, seats_open: 5, drop_count: null, stop_on_majority: true, majority: null,
    elect: [], seat_tied: [], seat_tie_count: 0, drop: [], tied: [], tie_drop_count: 0,
    options: Object.entries(votes).map(([id, v]) => ({
      id, label: id, description: '', votes: v, share: v / 30,
      qualifies: false, drops: false, tied: false,
    })),
    ...over,
  });

  test('everyone on X votes or fewer drops, ties and all', () => {
    const t = round({ A: 9, B: 7, C: 3, D: 3, E: 2, F: 1, G: 0, H: 5 });
    const p = previewDrop(t, 8, 'votes', 3);
    expect(p.drop.sort()).toEqual(['C', 'D', 'E', 'F', 'G']);
    expect(p.tieK).toBe(0);
    expect(p.left).toBe(3);
    expect(p.error).toContain('leaves 3 for 5 seats');
  });

  test('the lowest N, with a tie at the cut left for the chair', () => {
    const t = round({ A: 9, B: 7, C: 6, D: 4, E: 4, F: 1, G: 8 });
    const p = previewDrop(t, 7, 'count', 2);
    expect(p.drop).toEqual(['F']);
    expect(p.tied.sort()).toEqual(['D', 'E']);
    expect(p.tieK).toBe(1);
    expect(p.left).toBe(5);
    expect(p.error).toBeNull();
  });

  test('the elected are taken out before the rule applies', () => {
    const t = round({ A: 20, B: 18, C: 5, D: 4, E: 3, F: 2, G: 1, H: 1 }, { elect: ['A', 'B'] });
    const p = previewDrop(t, 8, 'votes', 1);
    expect(p.seatsAfter).toBe(3);
    expect(p.drop.sort()).toEqual(['G', 'H']);
    expect(p.left).toBe(4);
    expect(p.error).toBeNull();
  });

  test('a rule that would leave fewer than the seats is refused', () => {
    const t = round({ A: 6, B: 5, C: 4, D: 3, E: 2, F: 1 });
    expect(previewDrop(t, 6, 'count', 2).error).toContain('leaves 4 for 5 seats');
    expect(previewDrop(t, 6, 'count', 1).error).toBeNull();
    expect(previewDrop(t, 6, 'count', 9).error).toContain('Only 6 can drop');
  });

  test('nobody drops, and a missing number is asked for', () => {
    const t = round({ A: 6, B: 5, C: 4, D: 3, E: 2, F: 1, G: 0 });
    expect(previewDrop(t, 7, 'none', null)).toMatchObject({ drop: [], left: 7, error: null });
    expect(previewDrop(t, 7, 'votes', null).error).toBe('Give a number, 0 or more.');
  });

  test('a round that fills the seats asks nothing', () => {
    const full = round({ A: 20, B: 19, C: 3 }, { seats_open: 2, elect: ['A', 'B'] });
    expect(previewDrop(full, 3, 'votes', 5)).toMatchObject({ fills: true, drop: [], error: null });
    const lastLeft = round({ A: 4, B: 3, C: 2 }, { seats_open: 3 });
    expect(previewDrop(lastLeft, 3, null, null).fills).toBe(true);
  });

  test('a tie on the last seat holds those seats back from the drop', () => {
    const t = round({ A: 25, B: 24, C: 20, D: 20, E: 3, F: 1 },
      { seats_open: 3, elect: ['A', 'B'], seat_tied: ['C', 'D'], seat_tie_count: 1 });
    const p = previewDrop(t, 6, 'votes', 3);
    expect(p.seatsAfter).toBe(0);
    expect(p.fills).toBe(true);
  });

  test('one seat: drop the lowest until one is left, as before', () => {
    const t = round({ A: 3, B: 2, C: 2, D: 1 }, { seats: 1, seats_open: 1 });
    const p = previewDrop(t, 4, 'count', 2);
    expect(p.drop).toEqual(['D']);
    expect(p.tieK).toBe(1);
    expect(previewDrop(t, 4, 'count', 4).error).toContain('leaves 0 for 1 seat');
  });
});
