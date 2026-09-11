/**
 * Turning a pasted list into options.
 *
 * Organizers keep their candidates in a spreadsheet, so what arrives is a
 * column or a row: newline separated, comma separated, or both at once. Quoted
 * fields are respected, because a name like "Smith, J" pasted from a real CSV
 * is one option and not two.
 */

/** Splits on commas and newlines, honouring double-quoted fields. */
export function splitList(input: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }   // "" is one quote
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',' || ch === '\n' || ch === '\r') {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);

  return out.map((f) => f.trim()).filter((f) => f !== '');
}

/** The schema's own limit on a label. */
export const MAX_LABEL_LENGTH = 160;

export interface ParsedOptions {
  /** Ready to insert, in the order they were given. */
  labels: string[];
  /** Dropped because the question already has them, or the paste repeated them. */
  duplicates: string[];
  /** Dropped because they are longer than the column allows. */
  tooLong: string[];
}

/**
 * Parses a pasted list against the options a question already has.
 * Matching is case-insensitive, because the unique index behind it is.
 */
export function parseOptionList(input: string, existing: string[] = []): ParsedOptions {
  const seen = new Set(existing.map((label) => label.trim().toLowerCase()));
  const labels: string[] = [];
  const duplicates: string[] = [];
  const tooLong: string[] = [];

  for (const label of splitList(input)) {
    if (label.length > MAX_LABEL_LENGTH) { tooLong.push(label); continue; }
    const key = label.toLowerCase();
    if (seen.has(key)) { duplicates.push(label); continue; }
    seen.add(key);
    labels.push(label);
  }

  return { labels, duplicates, tooLong };
}
