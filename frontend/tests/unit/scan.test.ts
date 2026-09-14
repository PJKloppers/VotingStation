import { describe, expect, test } from 'bun:test';
import { pinFromScan, readDestination, routeFor } from '../../src/lib/scan';
import { explainAuthError } from '../../src/lib/authError';
import { hasPassword, readableProviders } from '../../src/lib/identities';

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

describe('a code that carries its own PIN', () => {
  test('the PIN comes back with the slugs', () => {
    expect(readDestination(`${SITE}#/vote/demo-society/agm-2026?pin=531907`))
      .toEqual({
        kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026', pin: '531907',
      });
  });

  test('and with a uuid, for a slip already handed out', () => {
    const id = '665306e5-d37f-4734-891a-0b42f9ee9ef9';
    expect(readDestination(`${SITE}#/vote/${id}?pin=531907`))
      .toEqual({ kind: 'ballot', ballotId: id, pin: '531907' });
  });

  test('without one, nothing is carried', () => {
    const to = readDestination(`${SITE}#/vote/demo-society/agm-2026`)!;
    expect('pin' in to && to.pin).toBeFalsy();
  });

  test('something that is not a PIN is ignored, not passed on', () => {
    for (const bad of ['pin=abc', 'pin=', 'pin=12', 'pin=1234567890123', "pin=' or 1=1"]) {
      const to = readDestination(`${SITE}#/vote/demo-society/agm-2026?${bad}`)!;
      expect(to).toEqual({ kind: 'slugs', orgSlug: 'demo-society', ballotSlug: 'agm-2026' });
    }
  });

  test('an organization link never carries one', () => {
    expect(readDestination(`${SITE}#/o/demo-society?pin=531907`))
      .toEqual({ kind: 'organization', orgSlug: 'demo-society' });
  });

  test('the route keeps it, and reading that back gives the same thing', () => {
    const to = readDestination(`${SITE}#/vote/demo-society/agm-2026?pin=531907`)!;
    expect(routeFor(to)).toBe('/vote/demo-society/agm-2026?pin=531907');
    expect(readDestination(routeFor(to))).toEqual(to);
  });
});

describe('the PIN a scanned code carries', () => {
  test('a barcode is the digits themselves', () => {
    expect(pinFromScan('091772')).toBe('091772');
    expect(pinFromScan('  091772 ')).toBe('091772');
  });

  test('a QR with the PIN printed into it', () => {
    expect(pinFromScan('https://host/#/vote/claude-society/agm?pin=091772')).toBe('091772');
    expect(pinFromScan('https://host/VotingStation/#/vote/dd9679be-0aec-4dde-bd62-01d8ca4d26bc?pin=4321'))
      .toBe('4321');
  });

  test('a QR from a sheet printed without the PIN carries none', () => {
    expect(pinFromScan('https://host/#/vote/claude-society/agm')).toBeNull();
  });

  test('somebody else\'s code is not a PIN', () => {
    expect(pinFromScan('tel:0115552368')).toBeNull();
    expect(pinFromScan('https://example.org/')).toBeNull();
    expect(pinFromScan('')).toBeNull();
  });

  test('a number that is not PIN-shaped is refused', () => {
    expect(pinFromScan('12')).toBeNull();                 // too short
    expect(pinFromScan('1234567890123')).toBeNull();      // too long
    expect(pinFromScan('09a772')).toBeNull();
  });
});

describe('what a failed sign-in is told to the organizer', () => {
  /*
   * The clock one is the reason this exists. "JWT issued at future" is true and
   * useless: a token carries the moment it was issued, whoever checks it
   * compares that against their own clock, and if the checker is behind then a
   * token minted a second ago reads as one from the future. On a Google sign-in
   * three clocks are involved and the message names none of them.
   */
  test('a clock-skew refusal is explained, not quoted', () => {
    for (const raw of ['JWT issued at future', 'jwt issued in the future',
                       'Token clock skew detected']) {
      const said = explainAuthError(raw);
      expect(said).not.toBe(raw);
      expect(said.toLowerCase()).toContain('clock');
      expect(said.toLowerCase()).toContain('try again');
    }
  });

  test('a refused redirect says which end is wrong', () => {
    const said = explainAuthError('redirect_to is not allowed');
    expect(said.toLowerCase()).toContain('allow-list');
  });

  test('anything else is passed through as the server said it', () => {
    expect(explainAuthError('Email link is invalid or has expired'))
      .toBe('Email link is invalid or has expired');
    expect(explainAuthError('')).toBe('');
  });
});

describe('what an account can be signed into with', () => {
  /*
   * The point of this is one decision: whether to offer a password to change.
   * An account made with Google has none, so the form would fail on the old
   * password every time with nothing to tell the organizer why.
   */
  const google = { provider: 'google' };
  const email = { provider: 'email' };

  test('a password account has one', () => {
    expect(hasPassword({ identities: [email] })).toBe(true);
  });

  test('a Google-only account does not', () => {
    expect(hasPassword({ identities: [google] })).toBe(false);
    expect(readableProviders({ identities: [google] })).toBe('Google');
  });

  test('linking Google does not take the password away', () => {
    const both = { identities: [email, google] };
    expect(hasPassword(both)).toBe(true);
    expect(readableProviders(both)).toBe('Google');
  });

  test('several third parties read as a list', () => {
    // capitalised by first letter only, so 'github' reads as 'Github' -- worth
    // fixing the day a second provider is actually offered, and not before
    expect(readableProviders({ identities: [google, { provider: 'github' }] }))
      .toBe('Google and Github');
    expect(readableProviders({
      identities: [google, { provider: 'github' }, { provider: 'apple' }],
    })).toBe('Google, Github and Apple');
  });

  test('an older session with no identities falls back to app_metadata', () => {
    expect(hasPassword({ app_metadata: { providers: ['email'] } })).toBe(true);
    expect(hasPassword({ app_metadata: { provider: 'google' } })).toBe(false);
    expect(readableProviders({ app_metadata: { provider: 'google' } })).toBe('Google');
  });

  test('identities win over app_metadata when both are there', () => {
    // app_metadata names only the provider last used; identities is the list
    expect(hasPassword({
      identities: [email, google],
      app_metadata: { provider: 'google' },
    })).toBe(true);
  });

  test('knowing nothing is not knowing there is a password', () => {
    expect(hasPassword({})).toBe(false);
    expect(readableProviders({})).toBe('');
  });

  test('the same provider twice is counted once', () => {
    expect(readableProviders({ identities: [google, google] })).toBe('Google');
  });
});
