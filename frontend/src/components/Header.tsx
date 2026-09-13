/**
 * The bar across the top of every page.
 *
 * Its own component because every page has one and none of them should be
 * assembling it: main.tsx used to hold the markup inline, which made the
 * header something you changed by editing the router.
 */
import { href } from '../lib/router';

export function Header({ session, at }: { session: boolean; at: string | undefined }) {
  return (
    <header className="topbar">
      <a className="brand" href={href('/')}>
        <span className="mark" aria-hidden="true">VS</span>
        VotingStation
      </a>
      <nav>
        <a href={href('/')} aria-current={at === undefined ? 'page' : undefined}>Scan</a>
        {session ? (
          <>
            <a href={href('/admin')} aria-current={at === 'admin' ? 'page' : undefined}>
              Organize
            </a>
            <a href={href('/pools')} aria-current={at === 'pools' ? 'page' : undefined}>
              Pools
            </a>
            {/* Signing out lives on the account page with the other thing you
                can do to an account, rather than sitting one stray click from
                Organize on every page. */}
            <a href={href('/account')} aria-current={at === 'account' ? 'page' : undefined}>
              Account
            </a>
          </>
        ) : (
          <a href={href('/signin')} aria-current={at === 'signin' ? 'page' : undefined}>
            Sign in
          </a>
        )}
      </nav>
    </header>
  );
}
