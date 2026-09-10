/** The link-safe form of a name. Matches the check constraint in the schema. */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return cleaned.length >= 3 ? cleaned : 'ballot';
}
