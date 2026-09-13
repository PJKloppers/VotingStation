import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';

import { useSession } from './lib/auth';
import { parseRoute, useRoute } from './lib/router';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Admin } from './pages/Admin';
import { Home } from './pages/Home';
import { Account } from './pages/Account';
import { Organization } from './pages/Organization';
import { Live } from './pages/Live';
import { Manage } from './pages/Manage';
import { PrivacyAndTerms } from './pages/PrivacyAndTerms';
import { Results } from './pages/Results';
import { SignIn } from './pages/SignIn';
import { Vote } from './pages/Vote';
import { Banner, Spinner } from './components/ui';

function App() {
  const route = useRoute();
  const { segments, query } = parseRoute(route);
  // A slip may carry its own code; the ballot page signs the voter in with it
  // and then takes it out of the address bar.
  const carried = query.get('pin') ?? undefined;
  const { session, ready } = useSession();
  const [head, first, second] = segments;

  const page = (() => {
    switch (head) {
      case undefined:
        return <Home />;
      case 'vote':
        if (!first) return <Home />;
        // Either form: the uuid, or the pair of slugs a printed slip carries.
        return second
          ? <Vote orgSlug={first} ballotSlug={second} pin={carried} />
          : <Vote ballotId={first} pin={carried} />;
      case 'results':
        if (!first) return <Home />;
        return second
          ? <Results orgSlug={first} ballotSlug={second} />
          : <Results ballotId={first} />;
      case 'o':
        // Where a code carrying a single slug lands.
        return first ? <Organization orgSlug={first} /> : <Home />;
      case 'privacy-and-terms-of-service':
        // Also reachable at this path without the fragment -- see lib/router.ts.
        return <PrivacyAndTerms />;
      case 'signin':
        return <SignIn />;
      case 'admin':
        if (!ready) return <main><Spinner label="Checking your session" /></main>;
        return session ? <Admin /> : <SignIn />;
      case 'account':
        if (!ready) return <main><Spinner label="Checking your session" /></main>;
        return session ? <Account session={session} /> : <SignIn />;
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

  return (
    <div className="shell">
      <Header session={!!session} at={head} />
      {page}
      <Footer />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('No #root in the page.');
createRoot(root).render(<StrictMode><App /></StrictMode>);
