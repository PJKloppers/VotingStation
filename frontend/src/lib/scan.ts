/**
 * Reading a VotingStation link out of a scanned code.
 *
 * Three forms have to work. Slips printed today carry the pair of slugs; slips
 * already handed out carry a uuid; and a code may carry only an organization.
 * A bare `org/ballot` with no URL around it is accepted too, because that is
 * what the text under the code on a slip looks like once a voter has retyped
 * the part they could read.
 */

/** Where a scanned or typed link should take the reader. */
export type Destination =
  | { kind: 'ballot'; ballotId: string }
  | { kind: 'slugs'; orgSlug: string; ballotSlug: string }
  | { kind: 'organization'; orgSlug: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i;

/** The app's own route prefixes. */
const PREFIXES = ['vote', 'results', 'o'];

/**
 * What a scanned code points at, or null if it is not one of ours.
 *
 * A URL has to prove it: it must carry one of the app's routes in its fragment.
 * Without that check the deploy's own path prefix made the bare site address
 * read as an organization called "votingstation", and so did any one-segment
 * URL from anywhere. A string with no scheme at all is taken as a path, which
 * is what someone retyping the line under a printed code produces.
 */
export function readDestination(text: string): Destination | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let path: string;

  if (isUrl) {
    const hash = trimmed.indexOf('#');
    if (hash < 0) return null;
    path = trimmed.slice(hash + 1);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;                       // tel:, mailto:, WIFI: -- somebody else's code
  } else {
    path = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  }

  const segments = (path.split('?')[0] ?? '').split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const head = segments[0]!.toLowerCase();
  const prefixed = PREFIXES.includes(head);
  if (isUrl && !prefixed) return null;

  const rest = prefixed ? segments.slice(1) : segments;
  const [first, second] = rest;
  if (!first) return null;

  if (UUID.test(first)) return { kind: 'ballot', ballotId: first.toLowerCase() };

  if (second) {
    return SLUG.test(first) && SLUG.test(second)
      ? { kind: 'slugs', orgSlug: first.toLowerCase(), ballotSlug: second.toLowerCase() }
      : null;
  }

  return SLUG.test(first) ? { kind: 'organization', orgSlug: first.toLowerCase() } : null;
}

/** The route for a destination. */
export function routeFor(to: Destination): string {
  if (to.kind === 'ballot') return `/vote/${to.ballotId}`;
  if (to.kind === 'slugs') return `/vote/${to.orgSlug}/${to.ballotSlug}`;
  return `/o/${to.orgSlug}`;
}
