import { describe, expect, test } from 'bun:test';
import { parseOptionList, splitList, MAX_LABEL_LENGTH } from '../../src/lib/options';
import { slugify, slugProblem } from '../../src/lib/slug';

describe('splitting a pasted list', () => {
  test('takes one name', () => {
    expect(splitList('Ann Meyer')).toEqual(['Ann Meyer']);
  });

  test('takes a column', () => {
    expect(splitList('Ann\nBen\nCara')).toEqual(['Ann', 'Ben', 'Cara']);
  });

  test('takes a row', () => {
    expect(splitList('Ann, Ben, Cara')).toEqual(['Ann', 'Ben', 'Cara']);
  });

  test('takes both at once', () => {
    expect(splitList('Ann, Ben\nCara, Dan')).toEqual(['Ann', 'Ben', 'Cara', 'Dan']);
  });

  test('survives the CRLF a Windows spreadsheet pastes', () => {
    expect(splitList('Ann\r\nBen\r\n')).toEqual(['Ann', 'Ben']);
  });

  test('drops blank lines and stray separators', () => {
    expect(splitList('\n\nAnn,,\n  \nBen,\n')).toEqual(['Ann', 'Ben']);
  });

  test('keeps a quoted comma inside one name', () => {
    expect(splitList('"Smith, J", Ben')).toEqual(['Smith, J', 'Ben']);
  });

  test('keeps a quoted newline inside one name', () => {
    expect(splitList('"Smith\nJ",Ben')).toEqual(['Smith\nJ', 'Ben']);
  });

  test('unescapes a doubled quote', () => {
    expect(splitList('"Ann ""The Whip"" Meyer"')).toEqual(['Ann "The Whip" Meyer']);
  });

  test('is empty for nothing', () => {
    expect(splitList('')).toEqual([]);
    expect(splitList('   \n , \n ')).toEqual([]);
  });
});

describe('parsing against what a question already has', () => {
  test('passes new labels through in order', () => {
    expect(parseOptionList('Ann\nBen').labels).toEqual(['Ann', 'Ben']);
  });

  test('skips one the question already has, whatever its case', () => {
    const parsed = parseOptionList('ANN\nBen', ['Ann']);
    expect(parsed.labels).toEqual(['Ben']);
    expect(parsed.duplicates).toEqual(['ANN']);
  });

  test('skips a repeat within the paste itself', () => {
    const parsed = parseOptionList('Ann\nBen\nann');
    expect(parsed.labels).toEqual(['Ann', 'Ben']);
    expect(parsed.duplicates).toEqual(['ann']);
  });

  test('matches the existing labels the way the unique index does', () => {
    // the index is on lower(btrim(label))
    expect(parseOptionList('  Ann  ', ['Ann']).labels).toEqual([]);
  });

  test('holds back a label the column would refuse', () => {
    const long = 'x'.repeat(MAX_LABEL_LENGTH + 1);
    const parsed = parseOptionList(`Ann\n${long}`);
    expect(parsed.labels).toEqual(['Ann']);
    expect(parsed.tooLong).toEqual([long]);
  });

  test('allows a label of exactly the maximum', () => {
    const edge = 'x'.repeat(MAX_LABEL_LENGTH);
    expect(parseOptionList(edge).labels).toEqual([edge]);
  });
});

describe('what the database will accept as a slug', () => {
  /*
   * These mirror `organizations_slug_check`. They are here so the form can say
   * what is wrong while it is being typed, rather than sending a name the
   * database will bounce with a sentence about a check constraint.
   */
  test('too short, and only just', () => {
    expect(slugProblem('ab')).toContain('three characters');
    expect(slugProblem('abc')).toBeNull();
  });

  test('too long, and only just', () => {
    expect(slugProblem('a'.repeat(50))).toBeNull();
    expect(slugProblem('a'.repeat(51))).toContain('fifty');
  });

  test('a dash may not start or end it', () => {
    expect(slugProblem('-society')).not.toBeNull();
    expect(slugProblem('society-')).not.toBeNull();
    expect(slugProblem('demo-society')).toBeNull();
  });

  test('nothing typed yet is not a fault to report', () => {
    expect(slugProblem('')).toBeNull();
  });

  test('what slugify makes of a real name passes', () => {
    for (const name of ['Demo Society', 'St. Andrew’s Parish Council',
                        'Workers’ Union 2026', 'A B']) {
      const made = slugify(name, 'organization');
      expect(slugProblem(made)).toBeNull();
    }
  });
});
