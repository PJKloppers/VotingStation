import { describe, expect, test } from 'bun:test';
import { minimumPicks, selectionError, thresholdRule } from '../../src/lib/rules';
import { slugify } from '../../src/lib/slug';
import type { LobbyQuestion } from '../../src/lib/types';

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
