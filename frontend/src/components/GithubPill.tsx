/**
 * A link to the repository, in GitHub's own pill shape.
 *
 * The mark is inlined rather than fetched: one more request for a decoration
 * is one more thing to fail on a venue's wifi, and `currentColor` lets the
 * same path sit on either theme without a second asset.
 */
export function GithubPill({
  owner = 'PJKloppers',
  repo = 'VotingStation',
  label = owner,
}: {
  owner?: string;
  repo?: string;
  /** What the pill reads. Defaults to the owner alone. */
  label?: string;
}) {
  return (
    <a
      className="github-pill"
      href={`https://github.com/${owner}/${repo}`}
      target="_blank"
      rel="noreferrer"
    >
      <span className="github-icon" aria-hidden="true">
        <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-1.13-1.74-1.15-.35 0-.03.17.07.24.38.18.65.86.74 1.08.13.31.54 1.25 2.14 1.08.01.88.01 1.73.01 1.94 0 .21-.15.46-.55.38A8.013 8.013 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
        </svg>
      </span>
      <span className="github-text">{label}</span>
    </a>
  );
}
