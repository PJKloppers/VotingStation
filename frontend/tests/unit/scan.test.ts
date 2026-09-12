import { describe, expect, test } from 'bun:test';
import { readDestination, routeFor } from '../../src/lib/scan';

const SITE = 'https://pjkloppers.github.io/VotingStation/';

describe('reading a scanned code', () => {
  test('the pair of slugs a slip prints today', () => {
    expect(readDestination(`${SITE}#/vote/demo-society/agm-2026`))
      .toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
  });

  test('the uuid on a slip already handed out', () => {
    const id = '665306e5-d37f-4734-891a-0b42f9ee9ef9';
    expect(readDestination(`${SITE}#/vote/${id}`)).toEqual({ kind: 'ballot', ballotId: id });
  });

  test('an organization on its own', () => {
    expect(readDestination(`${SITE}#/o/demo-society`))
      .toEqual({ kind: 'organization', orgSlug: 'demo-society' });
  });

  test('a bare org/ballot, as someone would retype it off a slip', () => {
    expect(readDestination('demo-society/agm-2026'))
      .toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
  });

  test('a bare organization', () => {
    expect(readDestination('demo-society'))
      .toEqual({ kind: 'organization', orgSlug: 'demo-society' });
  });

  test('a results link points at the same ballot', () => {
    expect(readDestination(`${SITE}#/results/demo-society/agm-2026`))
      .toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
  });

  test('it survives the rubbish that comes off a real scan', () => {
    expect(readDestination(`  ${SITE}#/vote/demo-society/agm-2026?x=1  `))
      .toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
    expect(readDestination('HTTP://LOCALHOST:4173/#/VOTE/Demo-Society/AGM-2026'))
      .toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
  });

  test('a URL has to carry one of our routes to count', () => {
    // The deploy's own path prefix would otherwise read as an organization
    // called "votingstation", and so would any one-segment URL anywhere.
    expect(readDestination(SITE)).toBeNull();
    expect(readDestination('https://example.com/')).toBeNull();
    expect(readDestination('https://example.com/demo-society')).toBeNull();
    expect(readDestination('https://example.com/#/somewhere/else')).toBeNull();
  });

  test('somebody else\'s QR code is not one of ours', () => {
    expect(readDestination('WIFI:S=CoffeeShop;T=WPA;P=hunter2;;')).toBeNull();
    expect(readDestination('')).toBeNull();
    expect(readDestination('tel:+27115550000')).toBeNull();
  });

  test('a slug too short to be one is refused', () => {
    expect(readDestination('ab/cd')).toBeNull();
  });

  test('every destination has a route, and it round-trips', () => {
    const cases = [
      `${SITE}#/vote/demo-society/agm-2026`,
      `${SITE}#/vote/665306e5-d37f-4734-891a-0b42f9ee9ef9`,
      `${SITE}#/o/demo-society`,
    ];
    for (const url of cases) {
      const to = readDestination(url)!;
      expect(readDestination(routeFor(to))).toEqual(to);
    }
  });
});
