/**
 * The rules of the bulk race form, kept free of the page so they can be
 * tested on their own.
 */

/** One race in the bulk form. */
export interface BulkRow { prompt: string; pool: string; majority: boolean }

/** Everything a race gets that the bulk form does not ask for. */
export const RACE_DEFAULTS = {
  nominate_max: null,        // as many as they like
  nominate_threshold: 1,
  pick_min: 1,
  pick_max: null,            // anyone in the round
  allow_abstain: false,
} as const;

/** Why these rows cannot be added yet, or null when they can. */
export function bulkProblem(rows: BulkRow[]): string | null {
  if (rows.length === 0) return 'Add a race first.';
  const i = rows.findIndex((r) => r.prompt.trim() === '');
  if (i >= 0) return `Race ${i + 1} needs a question.`;
  const j = rows.findIndex((r) => r.pool === '');
  if (j >= 0) return `Race ${j + 1} needs a pool.`;
  const seen = new Set<string>();
  for (const [k, r] of rows.entries()) {
    const key = r.prompt.trim().toLowerCase();
    if (seen.has(key)) return `Race ${k + 1} asks the same as an earlier one.`;
    seen.add(key);
  }
  return null;
}
