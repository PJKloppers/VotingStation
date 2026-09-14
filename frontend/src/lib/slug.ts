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

/**
 * What the database will accept as a slug, so a form can say so before the
 * insert does. Mirrors `organizations_slug_check`: three to fifty characters,
 * lower-case letters, digits and dashes, starting and ending on a character
 * that is not a dash.
 */
export const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/** Why this slug will not do, or null if it will. */
export function slugProblem(slug: string): string | null {
  if (slug.length === 0) return null;             // nothing typed yet is not a fault
  if (slug.length < 3) return 'A little longer — three characters at least.';
  if (slug.length > 50) return 'Too long — fifty characters at most.';
  if (!SLUG_SHAPE.test(slug)) return 'Lower-case letters, digits and dashes, not starting or ending on a dash.';
  return null;
}
