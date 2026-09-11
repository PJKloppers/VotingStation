/**
 * The link-safe form of a name. Matches the check constraint in the schema,
 * which wants at least three characters -- hence the fallback, which the caller
 * names because "ballot" is a poor answer when the thing is an organization.
 */
export function slugify(input: string, fallback = 'ballot'): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return cleaned.length >= 3 ? cleaned : fallback;
}
