/**
 * The foot of every page.
 *
 * Rendered once, in the shell around whichever view is showing, so a new page
 * gets it without remembering to ask for it -- and so there is one place to
 * change what it says.
 */
import { GithubPill } from './GithubPill';

export function Footer() {
  return (
    <footer className="site">
      <p className="site-note">
        Token voting for organizations · each question publishes when its gate closes
      </p>
      <GithubPill />
    </footer>
  );
}
