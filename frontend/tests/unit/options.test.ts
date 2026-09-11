import { describe, expect, test } from 'bun:test';
import { parseOptionList, splitList, MAX_LABEL_LENGTH } from '../../src/lib/options';

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
