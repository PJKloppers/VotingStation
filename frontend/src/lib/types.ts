/** The shapes the database hands back. Mirrors the jsonb built in the RPCs. */

export type QuestionType = 'yes_no' | 'highest_outright' | 'highest_x';

export const QUESTION_TYPE_NAMES: Record<QuestionType, string> = {
  yes_no: 'Yes / No',
  highest_outright: 'Highest outright',
  highest_x: 'Highest X options',
};

/** An organization's mark, as stored. */
export interface OrganizationImage {
  id: string;
  org_id: string;
  kind: 'logo';
  bucket: string;
  path: string;
  content_type: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

export interface Organization {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string;
  contact: string;
  created_at: string;
}

/** A ballot a PIN was found on. */
export interface PinMatch {
  ballot_id: string;
  title: string;
  status: 'live' | 'closed';
  org_name: string;
  org_slug: string;
  org_logo_path: string | null;
}

export interface Ballot {
  id: string;
  org_id: string;
  slug: string;
  title: string;
  description: string;
  status: 'draft' | 'live' | 'closed';
  mode: 'gated' | 'open';
  opens_at: string | null;
  closes_at: string | null;
  allow_vote_change: boolean;
  require_all: boolean;
  /** Gated mode: the chair cannot step past a question until every active PIN has answered it. */
  require_all_pins: boolean;
  anonymous: boolean;
  show_results_after: boolean;
  results_public: boolean;
  intro_message: string;
  waiting_message: string;
  all_done_message: string;
  thank_you_message: string;
  closed_message: string;
  already_voted_message: string;
  lobby_refresh_seconds: number;
  /** When the purge takes it. Pushed out by renewing. */
  expires_at: string;
}

/** The columns every question table repeats, whatever its type. */
export interface QuestionCommon {
  id: string;
  ballot_id: string;
  prompt: string;
  description: string;
  sort_order: number;
  enabled: boolean;
  gate_open: boolean;
  opened_at: string | null;
  closed_at: string | null;
}

export interface YesNoQuestion extends QuestionCommon {
  yes_label: string;
  no_label: string;
  allow_abstain: boolean;
  abstain_label: string;
  pass_num: number;
  pass_den: number;
  threshold_strict: boolean;
}

export interface HighestOutrightQuestion extends QuestionCommon {
  require_majority: boolean;
  allow_abstain: boolean;
  abstain_label: string;
}

export interface HighestXQuestion extends QuestionCommon {
  select_min: number;
  select_max: number;
  winner_count: number;
}

export interface QuestionOption {
  id: string;
  question_id: string;
  label: string;
  description: string;
  enabled: boolean;
  sort_order: number;
}

/* ------------------------------------------------------------- the voter */

export interface BallotOption {
  id: string;
  label: string;
  description: string;
}

export interface LobbyQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  description: string;
  gate_open: boolean;
  config: Record<string, unknown>;
  options: BallotOption[];
  voted: boolean;
  /** 'yes' | 'no' | 'abstain', an option id, 'abstain', or an array of ids. */
  previous: string | string[] | null;
}

export interface VoterState {
  ok: true;
  ballot: {
    id: string;
    title: string;
    description: string;
    mode: 'gated' | 'open';
    allow_vote_change: boolean;
    require_all: boolean;
    show_results_after: boolean;
    waiting_message: string;
    all_done_message: string;
    already_voted_message: string;
    lobby_refresh_seconds: number;
    /** Path into the public logo bucket, or null. */
    org_logo_path: string | null;
  };
  voter: { weight: number };
  progress: { voted: number; open_now: number; total: number };
  questions: LobbyQuestion[];
  /**
   * What this voter has answered that is now finished -- gate closed, or the
   * whole ballot closed -- with its count. Empty while a question is still
   * taking votes, and empty unless the ballot shows voters their results.
   */
  settled: QuestionResult[];
}

export interface Refused {
  ok: false;
  error: string;
  closed?: boolean;
}

export interface Accepted {
  ok: true;
  submission_id: string;
  question_id: string;
  message: string;
  results: QuestionResult | null;
  state: VoterState | Refused;
}

/* ----------------------------------------------------------- the results */

export interface YesNoTally {
  yes: number;
  no: number;
  abstain: number;
  cast: number;
  decisive: number;
  voters: number;
  yes_share: number | null;
  threshold: string;
  threshold_strict: boolean;
  carried: boolean | null;
  labels: { yes: string; no: string; abstain: string };
}

export interface CountedOption {
  id: string;
  label: string;
  description: string;
  votes: number;
  rank: number | null;
  share: number;
  elected?: boolean;
}

export interface OutrightTally {
  total: number;
  abstain: number;
  voters: number;
  require_majority: boolean;
  tied: boolean;
  majority_reached: boolean;
  winner: string | null;
  options: CountedOption[];
}

export interface HighestXTally {
  total: number;
  voters: number;
  submissions: number;
  winner_count: number;
  select_min: number;
  select_max: number;
  tied_at_cut: boolean;
  winners: string[];
  options: CountedOption[];
}

interface QuestionResultBase {
  id: string;
  prompt: string;
  description: string;
  gate_open: boolean;
  /** Distinct voters with a standing answer on this question. */
  voted: number;
  /**
   * Who this question is waiting on: the active PINs, plus any PIN that has
   * already answered it. A disabled voter's answer still counts in the tally,
   * so it counts here too; one disabled before answering is not waited for.
   */
  expected: number;
}

export type QuestionResult =
  | (QuestionResultBase & { type: 'yes_no'; tally: YesNoTally })
  | (QuestionResultBase & { type: 'highest_outright'; tally: OutrightTally })
  | (QuestionResultBase & { type: 'highest_x'; tally: HighestXTally });

export interface BallotResults {
  ok: true;
  updated: string;
  ballot: {
    id: string; title: string; description: string; status: string; mode: string;
    org_logo_path: string | null;
  };
  turnout: { issued: number; used: number; eligible: number };
  /** Questions not published yet, so a short list does not read as the whole ballot. */
  withheld: number;
  questions: QuestionResult[];
}

export interface TokenRow {
  id: string;
  pin: string;
  status: 'active' | 'disabled';
  weight: number;
  questions_voted: number;
  last_vote_at: string | null;
}

export interface TokenReport {
  issued: number;
  used: number;
  disabled: number;
  tokens: TokenRow[];
}
