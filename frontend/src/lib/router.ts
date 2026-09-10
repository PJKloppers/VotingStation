import { useSyncExternalStore } from 'react';

/**
 * Hash routing, because GitHub Pages has no rewrite rule to give an SPA. The
 * whole app lives at one URL and the fragment says which page.
 */
function read(): string {
  const raw = window.location.hash.replace(/^#/, '');
  return raw === '' ? '/' : raw;
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

/** Splits '/vote/abc?x=1' into its segments and its query. */
export function parseRoute(route: string): { segments: string[]; query: URLSearchParams } {
  const [path = '', search = ''] = route.split('?');
  return {
    segments: path.split('/').filter(Boolean),
    query: new URLSearchParams(search),
  };
}
