/**
 * The selection rules, checked in the browser.
 *
 * The database checks all of this again and only its answer decides what is
 * stored. This copy exists so a voter finds out they have picked a fourth
 * candidate before they press the button, not after a round trip.
 */
import type { LobbyQuestion } from './types';

export interface YesNoConfig {
  yes_label: string; no_label: string;
  allow_abstain: boolean; abstain_label: string;
  pass_num: number; pass_den: number; threshold_strict: boolean;
}
export interface OutrightConfig {
  require_majority: boolean; allow_abstain: boolean; abstain_label: string;
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
