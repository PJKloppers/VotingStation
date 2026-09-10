import { describe, expect, test } from 'bun:test';
import { parseRoute } from '../../src/lib/router';

describe('routes', () => {
  test('splits a path into segments', () => {
    expect(parseRoute('/vote/abc').segments).toEqual(['vote', 'abc']);
  });
  test('treats the root as no segments', () => {
    expect(parseRoute('/').segments).toEqual([]);
  });
  test('ignores repeated and trailing slashes', () => {
    expect(parseRoute('//manage//xyz//').segments).toEqual(['manage', 'xyz']);
  });
  test('keeps the query out of the segments', () => {
    const { segments, query } = parseRoute('/results/abc?pin=1234');
    expect(segments).toEqual(['results', 'abc']);
    expect(query.get('pin')).toBe('1234');
  });
});
