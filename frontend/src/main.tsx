import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';

import { useSession, signOut } from './lib/auth';
import { href, parseRoute, useRoute } from './lib/router';
import { Admin } from './pages/Admin';
import { Home } from './pages/Home';
import { Live } from './pages/Live';
import { Manage } from './pages/Manage';
import { Results } from './pages/Results';
import { SignIn } from './pages/SignIn';
import { Vote } from './pages/Vote';
import { Banner, Spinner } from './components/ui';

function App() {
  const route = useRoute();
  const { segments } = parseRoute(route);
  const { session, ready } = useSession();
  const [head, first, second] = segments;

  const page = (() => {
    switch (head) {
      case undefined:
        return <Home />;
      case 'vote':
        return first ? <Vote ballotId={first} /> : <Home />;
      case 'results':
        return first ? <Results ballotId={first} /> : <Home />;
      case 'signin':
        return <SignIn />;
      case 'admin':
        if (!ready) return <main><Spinner label="Checking your session" /></main>;
        return session ? <Admin /> : <SignIn />;
      case 'manage':
        if (!ready) return <main><Spinner label="Checking your session" /></main>;
        if (!session) return <SignIn />;
        return first ? <Manage ballotId={first} /> : <Admin />;
      case 'live':
        // Signed in only: while a ballot is running its count is the
        // organizer's alone, and the database agrees.
        if (!ready) return <main><Spinner label="Checking your session" /></main>;
        if (!session) return <SignIn />;
        return first ? <Live ballotId={first} /> : <Admin />;
      default:
        return (
          <main className="narrow">
            <Banner kind="error">There is no page at {route}.</Banner>
          </main>
        );
    }
  })();

  // `second` is reserved for the org/ballot slug form of a voting link.
  void second;

  return (
    <div className="shell">
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
          <a href={href('/')} aria-current={head === undefined ? 'page' : undefined}>Ballots</a>
          {session ? (
            <>
              <a href={href('/admin')} aria-current={head === 'admin' ? 'page' : undefined}>Organize</a>
              <button onClick={() => void signOut()}>Sign out</button>
            </>
          ) : (
            <a href={href('/signin')} aria-current={head === 'signin' ? 'page' : undefined}>Sign in</a>
          )}
        </nav>
      </header>

      {page}

      <footer className="site">
        Token voting for organizations · each question publishes when its gate closes
      </footer>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('No #root in the page.');
createRoot(root).render(<StrictMode><App /></StrictMode>);
