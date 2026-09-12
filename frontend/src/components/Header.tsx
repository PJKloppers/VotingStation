/**
 * The bar across the top of every page.
 *
 * Its own component because every page has one and none of them should be
 * assembling it: main.tsx used to hold the markup inline, which made the
 * header something you changed by editing the router.
 */
import { signOut } from '../lib/auth';
import { href } from '../lib/router';

export function Header({ session, at }: { session: boolean; at: string | undefined }) {
  return (
    <header className="topbar">
      <div className="brand-block">
        <a className="brand" href={href('/')}>
          <span className="mark" aria-hidden="true">VS</span>
          VotingStation
        </a>
        <a
          className="brand-repo"
          href="https://github.com/PJKloppers/VotingStation"
          target="_blank"
          rel="noreferrer"
        >
          github.com/PJKloppers/VotingStation
        </a>
      </div>
      <nav>
        <a href={href('/')} aria-current={at === undefined ? 'page' : undefined}>Scan</a>
        {session ? (
          <>
            <a href={href('/admin')} aria-current={at === 'admin' ? 'page' : undefined}>
              Organize
            </a>
            <button onClick={() => void signOut()}>Sign out</button>
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

/** The line at the foot of every page. */
export function Footer() {
  return (
    <footer className="site">
      Token voting for organizations · each question publishes when its gate closes
    </footer>
  );
}
