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
  | { kind: 'ballot'; ballotId: string; pin?: string }
  | { kind: 'slugs'; orgSlug: string; ballotSlug: string; pin?: string }
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

  const [beforeQuery = '', query = ''] = path.split('?');
  const segments = beforeQuery.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // A slip may carry its own code, if the organizer chose to print it that way.
  const carried = new URLSearchParams(query).get('pin');
  const pin = carried && /^[0-9]{4,12}$/.test(carried.trim())
    ? carried.trim() : undefined;

  const head = segments[0]!.toLowerCase();
  const prefixed = PREFIXES.includes(head);
  if (isUrl && !prefixed) return null;

  const rest = prefixed ? segments.slice(1) : segments;
  const [first, second] = rest;
  if (!first) return null;

  if (UUID.test(first)) {
    return { kind: 'ballot', ballotId: first.toLowerCase(), ...(pin ? { pin } : {}) };
  }

  if (second) {
    return SLUG.test(first) && SLUG.test(second)
      ? {
          kind: 'slugs',
          orgSlug: first.toLowerCase(),
          ballotSlug: second.toLowerCase(),
          ...(pin ? { pin } : {}),
        }
      : null;
  }

  return SLUG.test(first) ? { kind: 'organization', orgSlug: first.toLowerCase() } : null;
}

/** The route for a destination, code and all. */
export function routeFor(to: Destination): string {
  if (to.kind === 'organization') return `/o/${to.orgSlug}`;
  const path = to.kind === 'ballot'
    ? `/vote/${to.ballotId}`
    : `/vote/${to.orgSlug}/${to.ballotSlug}`;
  return to.pin ? `${path}?pin=${to.pin}` : path;
}

/**
 * The PIN a scanned code carries, or null.
 *
 * Two shapes reach this. A slip's barcode holds the digits and nothing else.
 * A slip's QR holds the ballot's address, which carries a PIN only when the
 * organizer chose to print it that way -- so a QR from a sheet printed without
 * that setting has no PIN in it, and says so rather than guessing.
 */
export function pinFromScan(text: string): string | null {
  const trimmed = text.trim();
  if (/^[0-9]{4,12}$/.test(trimmed)) return trimmed;

  const to = readDestination(trimmed);
  // An organization's code addresses no ballot, so it carries no PIN either.
  return to && to.kind !== 'organization' ? to.pin ?? null : null;
}
