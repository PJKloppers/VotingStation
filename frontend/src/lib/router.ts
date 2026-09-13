import { useSyncExternalStore } from 'react';

/**
 * Hash routing, because GitHub Pages has no rewrite rule to give an SPA. The
 * whole app lives at one URL and the fragment says which page.
 *
 * One kind of page is the exception. A document that has to be handed to
 * somebody outside the app -- Google's OAuth consent screen wants a privacy
 * policy URL, and a `#` fragment is a poor thing to give a reviewer -- also
 * answers to a real path. Pages serves 404.html for a path it does not have a
 * file for, and build.ts makes that a copy of the app, so such a request
 * arrives here with the route still sitting in `location.pathname`.
 */

/**
 * Routes that answer to a path as well as to the hash.
 *
 * Matched on the last segment alone, because the prefix the app is served
 * from is not knowable from in here: Pages puts it under /VotingStation/, a
 * test serves it from wherever it likes, and a domain root has no prefix at
 * all. The last segment is what was asked for either way.
 */
const PATH_ROUTES = ['privacy-and-terms-of-service'];

function fromPath(): string | null {
  const last = window.location.pathname.split('/').filter(Boolean).pop();
  return last && PATH_ROUTES.includes(last) ? `/${last}` : null;
}

function read(): string {
  const raw = window.location.hash.replace(/^#/, '');
  // A fragment always wins: it is what every link in the app sets, so a path
  // page that navigates into the app must not keep answering for its path.
  if (raw !== '') return raw;
  return fromPath() ?? '/';
}

function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

export function useRoute(): string {
  return useSyncExternalStore(subscribe, read, () => '/');
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function href(path: string): string {
  return `#${path}`;
}

/**
 * A link to one of the path routes above, as a path rather than a fragment.
 *
 * Relative, so the browser resolves it against the document it is in -- which
 * is the one thing that knows the deploy prefix. `#/x` still reaches the same
 * page; this is the form a person can be handed. It leaves off the trailing
 * slash on purpose: the build emits relative asset paths, and a trailing
 * slash would make them resolve one directory too deep.
 */
export function pathHref(route: string): string {
  return route.replace(/^\//, '');
}

/** Splits '/vote/abc?x=1' into its segments and its query. */
export function parseRoute(route: string): { segments: string[]; query: URLSearchParams } {
  const [path = '', search = ''] = route.split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: new URLSearchParams(search),
  };
}
