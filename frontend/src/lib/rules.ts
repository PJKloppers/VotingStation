/**
 * The selection rules, checked in the browser.
 *
 * The database checks all of this again and only its answer decides what is
 * stored. This copy exists so a voter finds out they have picked a fourth
 * candidate before they press the button, not after a round trip.
 */
import type { DropRule, LobbyQuestion, RecursionRoundTally } from './types';

export interface YesNoConfig {
  yes_label: string; no_label: string;
  allow_abstain: boolean; abstain_label: string;
  pass_num: number; pass_den: number; threshold_strict: boolean;
}
export interface OutrightConfig {
  require_majority: boolean; allow_abstain: boolean; abstain_label: string;
}
export interface RecursionConfig {
  round: number; kind: 'nomination' | 'elimination';
  pick_min: number; pick_max: number;
  allow_abstain: boolean; abstain_label: string;
  /** Absent before seats existed: read as 1. */
  seats?: number; seats_open?: number;
}
export interface HighestXConfig {
  select_min: number; select_max: number; winner_count: number;
}

/** How many picks this question needs at a minimum. Zero is never a ballot. */
export function minimumPicks(config: HighestXConfig): number {
  return Math.max(config.select_min, 1);
}

/**
 * Why this selection cannot be submitted yet, or null when it can.
 * `chosen` is the option ids for highest_x, or the single answer otherwise.
 */
export function selectionError(question: LobbyQuestion, chosen: string[]): string | null {
  const known = new Set(question.options.map((o) => o.id));

  if (question.type === 'yes_no') {
    const cfg = question.config as unknown as YesNoConfig;
    const answer = chosen[0];
    if (chosen.length !== 1 || answer === undefined) return 'Choose an answer.';
    if (answer === 'abstain' && !cfg.allow_abstain) return 'This question does not allow abstentions.';
    if (!['yes', 'no', 'abstain'].includes(answer)) return 'Choose an answer.';
    return null;
  }

  if (question.type === 'highest_outright') {
    const cfg = question.config as unknown as OutrightConfig;
    const answer = chosen[0];
    if (chosen.length !== 1 || answer === undefined) return 'Choose one option.';
    if (answer === 'abstain') {
      return cfg.allow_abstain ? null : 'This question does not allow abstentions.';
    }
    return known.has(answer) ? null : 'That option is not available.';
  }

  if (question.type === 'recursion_filter') {
    const cfg = question.config as unknown as RecursionConfig;
    if (chosen.length === 1 && chosen[0] === 'abstain') {
      return cfg.allow_abstain ? null : 'This question does not allow abstentions.';
    }
    const picked = new Set(chosen.filter((id) => known.has(id)));
    const min = Math.max(cfg.pick_min, 1);
    if (picked.size < min) return min === 1 ? 'Choose someone.' : `Choose at least ${min}.`;
    if (picked.size > cfg.pick_max) return `Choose at most ${cfg.pick_max}.`;
    return null;
  }

  const cfg = question.config as unknown as HighestXConfig;
  const unique = new Set(chosen.filter((id) => known.has(id)));
  const min = minimumPicks(cfg);
  if (unique.size < min) return `Choose at least ${min}.`;
  if (unique.size > cfg.select_max) return `Choose at most ${cfg.select_max}.`;
  return null;
}

/** The sentence that describes a yes/no question's threshold. */
export function thresholdRule(threshold: string, strict: boolean): string {
  if (threshold === '1/2' && strict) return 'simple majority';
  return `${strict ? 'more than' : 'at least'} ${threshold} of the decisive votes`;
}

/* ------------------------------------------------- the drop-off question */

export interface DropPreview {
  /** Who drops for certain. */
  drop: string[];
  /** A tie at the cut, and how many of them the chair must choose to drop. */
  tied: string[];
  tieK: number;
  /** People left in the race after this round, and seats left. */
  left: number;
  seatsAfter: number;
  /** The round fills the seats whatever the rule: nothing to ask. */
  fills: boolean;
  /** Why the rule cannot be used, or null. */
  error: string | null;
}

/**
 * What a drop rule would do to a round, worked out the way the database
 * settles it: the elected are taken out first, then the rule applies to the
 * rest, and it may never leave fewer people than seats.
 *
 * This is the live preview in the chair's dialog. The database works it out
 * again when the round settles, and only that answer counts.
 *
 * `inRace` is everyone still in the race, including anyone added who joins
 * a later round.
 */
export function previewDrop(
  t: RecursionRoundTally, inRace: number, rule: DropRule | null, n: number | null,
): DropPreview {
  const elected = new Set([...(t.elect ?? []), ...(t.seat_tied ?? [])]);
  const reserved = (t.elect?.length ?? 0) + (t.seat_tie_count ?? 0);
  const seatsOpen = t.seats_open ?? 1;
  const seatsAfter = Math.max(seatsOpen - reserved, 0);
  const inAfter = inRace - reserved;
  const fills = seatsAfter <= 0 || inAfter <= seatsAfter;
  const none: DropPreview = { drop: [], tied: [], tieK: 0, left: inAfter, seatsAfter, fills, error: null };
  if (fills || rule === null || rule === 'none') return none;
  if (n === null || !Number.isInteger(n) || n < 0) return { ...none, error: 'Give a number, 0 or more.' };

  // the rest, lowest first; ties keep the database's order (by name)
  const rest = t.options
    .filter((o) => !elected.has(o.id))
    .sort((a, b) => a.votes - b.votes || a.label.localeCompare(b.label));

  let drop: string[] = [];
  let tied: string[] = [];
  let tieK = 0;
  if (rule === 'count' && n > 0) {
    if (n > rest.length) return { ...none, error: `Only ${rest.length} can drop from this round.` };
    const cut = rest[n - 1]!.votes;
    const below = rest.filter((o) => o.votes < cut).map((o) => o.id);
    const equal = rest.filter((o) => o.votes === cut).map((o) => o.id);
    tieK = n - below.length;
    if (tieK === equal.length) { drop = [...below, ...equal]; tieK = 0; }
    else { drop = below; tied = equal; }
  } else if (rule === 'votes') {
    drop = rest.filter((o) => o.votes <= n).map((o) => o.id);
  }

  const left = inAfter - drop.length - tieK;
  const error = left < seatsAfter
    ? `This drops ${drop.length + tieK} and leaves ${left} for ${seatsAfter} seat${seatsAfter === 1 ? '' : 's'}. Lower the number.`
    : null;
  return { drop, tied, tieK, left, seatsAfter, fills, error };
}
