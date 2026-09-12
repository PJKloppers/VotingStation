/**
 * A page addressed either way.
 *
 * `/vote/<uuid>` is what the app links to itself; `/vote/<org>/<ballot>` is
 * what a printed slip carries, because a person has to be able to read it and
 * type it. Both land on the same ballot, and this is where the second becomes
 * the first.
 */
import { useEffect, useState } from 'react';
import * as api from './api';

export type Address = { ballotId: string } | { orgSlug: string; ballotSlug: string };

export interface Resolved {
  ballotId: string | null;
  /** Still looking. Distinct from "looked, and there is nothing there". */
  pending: boolean;
}

export function useBallotId(address: Address): Resolved {
  const direct = 'ballotId' in address ? address.ballotId : null;
  const org = 'orgSlug' in address ? address.orgSlug : null;
  const slug = 'ballotSlug' in address ? address.ballotSlug : null;

  const [state, setState] = useState<Resolved>(
    direct ? { ballotId: direct, pending: false } : { ballotId: null, pending: true },
  );

  useEffect(() => {
    if (direct) { setState({ ballotId: direct, pending: false }); return; }
    if (!org || !slug) { setState({ ballotId: null, pending: false }); return; }

    let live = true;
    setState({ ballotId: null, pending: true });
    api.resolveBallot(org, slug)
      .then((id) => { if (live) setState({ ballotId: id, pending: false }); })
      .catch(() => { if (live) setState({ ballotId: null, pending: false }); });
    return () => { live = false; };
  }, [direct, org, slug]);

  return state;
}
