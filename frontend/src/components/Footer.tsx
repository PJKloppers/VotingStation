/**
 * The foot of every page.
 *
 * Rendered once, in the shell around whichever view is showing, so a new page
 * gets it without remembering to ask for it -- and so there is one place to
 * change what it says.
 */
import { GithubPill } from './GithubPill';
import { pathHref } from '../lib/router';

export function Footer() {
  return (
    <footer className="site">
      <p className="site-note">
        Token voting for organizations · each question publishes when its gate closes
      </p>
      <div className="site-links">
        {/* The path form rather than the hash: this is the link that gets
            handed to somebody outside the app, so it is the one to show. */}
        <a className="doc-link" href={pathHref('/privacy-and-terms-of-service')}>
          Privacy and terms
        </a>
        <GithubPill />
      </div>
    </footer>
  );
}
