import { describe, expect, test } from 'bun:test';
import { appBase, parseRoute } from '../../src/lib/router';

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

describe('the app\'s own base URL', () => {
  /*
   * A path route is served by 404.html, so the address bar can read
   * `/privacy-and-terms-of-service#/admin`: the fragment moved into the app,
   * the path stayed on the document. Anything building an absolute URL from
   * `pathname` then carried that path with it -- which is how a voting link
   * came out as `…/privacy-and-terms-of-service#/vote/<id>`, and how the same
   * wrong address was printed into the QR code on every slip.
   */
  const at = (href: string) => {
    const url = new URL(href);
    (globalThis as unknown as { window: unknown }).window = {
      location: { origin: url.origin, pathname: url.pathname },
    };
    return appBase();
  };

  test('a deploy under a prefix', () => {
    expect(at('https://pjkloppers.github.io/VotingStation/#/admin'))
      .toBe('https://pjkloppers.github.io/VotingStation/');
  });

  test('a domain of its own', () => {
    expect(at('https://vote.paulkloppers.co.za/#/admin'))
      .toBe('https://vote.paulkloppers.co.za/');
  });

  test('the path route drops off at a domain root', () => {
    expect(at('https://vote.paulkloppers.co.za/privacy-and-terms-of-service#/admin'))
      .toBe('https://vote.paulkloppers.co.za/');
  });

  test('and under a prefix, leaving the prefix behind', () => {
    expect(at('https://pjkloppers.github.io/VotingStation/privacy-and-terms-of-service#/admin'))
      .toBe('https://pjkloppers.github.io/VotingStation/');
  });

  test('a path that merely ends in something similar is left alone', () => {
    expect(at('https://example.org/privacy-and-terms-of-service-2/#/admin'))
      .toBe('https://example.org/privacy-and-terms-of-service-2/');
  });

  test('a file name is not a route and is left exactly as it was', () => {
    expect(at('https://example.org/app/index.html#/admin'))
      .toBe('https://example.org/app/index.html');
  });
});
