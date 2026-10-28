/** The shapes the database hands back. Mirrors the jsonb built in the RPCs. */

export type QuestionType = 'yes_no' | 'highest_outright' | 'highest_x' | 'recursion_filter';

export const QUESTION_TYPE_NAMES: Record<QuestionType, string> = {
  yes_no: 'Yes / No',
  highest_outright: 'Highest outright',
  highest_x: 'Highest X options',
  recursion_filter: 'Recursion filter',
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

/** A reusable list of options, kept on an organization. */
export interface OptionPool {
  id: string;
  org_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface OptionPoolEntry {
  id: string;
  pool_id: string;
  label: string;
  description: string;
  sort_order: number;
}

/** One organization's published ballots, for the page a scanned slug lands on. */
export interface OrgPage {
  org: {
    slug: string;
    name: string;
    description: string;
    logo_path: string | null;
  };
  ballots: Array<{
    id: string;
    slug: string;
    title: string;
    description: string;
    status: 'live' | 'closed';
    results_public: boolean;
  }>;
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

/**
 * One person for a role, in rounds. The settings are the organizer's; the
 * rest (current_round, phase, winner_id and the gate) only the round
 * functions move.
 */
export interface RecursionFilterQuestion extends QuestionCommon {
  nominate_max: number;
  nominate_threshold: number;
  pick_min: number;
  pick_max: number;
  stop_on_majority: boolean;
  allow_abstain: boolean;
  abstain_label: string;
  /** 1 is a single winner (a chairperson); more is a committee. */
  seats: number;
  current_round: number;
  phase: 'nominating' | 'eliminating' | 'decided';
  winner_id: string | null;
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
  /** Null on a public X-of-N result: the seats are shown, the counts are not. */
  votes: number | null;
  rank: number | null;
  share: number | null;
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
  /**
   * True when this is the public view: the elected only, in a random order,
   * with no counts. An X-of-N result published in full is a league table of
   * everyone who stood.
   */
  redacted?: boolean;
  total: number | null;
  voters: number;
  submissions: number;
  winner_count: number;
  select_min: number;
  select_max: number;
  tied_at_cut: boolean;
  winners: string[];
  options: CountedOption[];
}

/** One round of a recursion filter, as counted (live) or as it was settled. */
export interface RecursionRoundTally {
  round: number;
  kind: 'nomination' | 'elimination';
  gate_open: boolean;
  opened: boolean;
  settled: boolean;
  voters: number;
  /** Weighted voters who picked someone, i.e. did not abstain. */
  ballots: number;
  abstain: number;
  pick_min: number;
  pick_max: number;
  threshold: number | null;
  /** Seats in the question, and seats still open in this round. */
  seats?: number;
  seats_open?: number;
  drop_rule?: DropRule | null;
  drop_count: number | null;
  drop_votes?: number | null;
  stop_on_majority: boolean;
  majority: string | null;
  /** Who settling now would elect, and any tie on the last seat. */
  elect?: string[];
  seat_tied?: string[];
  seat_tie_count?: number;
  /** True when this round fills the seats whatever the drop rule says. */
  fills?: boolean;
  seats_after?: number;
  left_after?: number | null;
  /** Why the drop rule as set cannot be used. */
  drop_error?: string | null;
  drop: string[];
  tied: string[];
  tie_drop_count: number;
  options: RoundOption[];
}

export interface RoundOption {
  id: string; label: string; description: string;
  votes: number; share: number;
  qualifies: boolean; drops: boolean; tied: boolean;
  majority?: boolean; elected?: boolean; seat_tied?: boolean;
}

/** How people drop out of a round: the lowest N, X votes or fewer, or nobody. */
export type DropRule = 'count' | 'votes' | 'none';

export interface RecursionRound {
  round: number;
  kind: 'nomination' | 'elimination';
  settled: boolean;
  drop_count: number | null;
  drop_rule?: DropRule | null;
  drop_votes?: number | null;
  seats_open?: number;
  tally: RecursionRoundTally;
  elected?: Array<{ id: string; label: string; seat: number }>;
  drop_n?: number | null;
  seat_tie_broken_by_chair?: boolean;
  seats_left?: number;
  dropped?: Array<{ id: string; label: string }>;
  withdrawn?: Array<{ id: string; label: string }>;
  shortlisted?: Array<{ id: string; label: string }>;
  shortlist_by_chair?: boolean;
  tie_broken_by_chair?: boolean;
  ended_by_chair?: boolean;
  how?: 'majority' | 'last_left' | 'chair' | 'no_winner';
  winner?: string | null;
}

export type CandidateStatus = 'pool' | 'in' | 'dropped' | 'withdrawn' | 'winner' | 'elected';

export interface RecursionCandidate {
  id: string;
  label: string;
  description: string;
  status: CandidateStatus;
  joined_round: number | null;
  dropped_round: number | null;
  added_by_chair: boolean;
  elected_round?: number | null;
  seat_no?: number | null;
}

export interface RecursionTally {
  phase: 'nominating' | 'eliminating' | 'decided';
  current_round: number;
  stop_on_majority: boolean;
  nominate_threshold: number;
  /** Absent on a database that predates seats: read as 1. */
  seats?: number;
  winner: { id: string; label: string } | null;
  /** Everyone holding a seat, in seat order. */
  elected?: Array<{ id: string; label: string; round: number | null; seat: number | null }>;
  candidates: RecursionCandidate[];
  rounds: RecursionRound[];
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
  | (QuestionResultBase & { type: 'highest_x'; tally: HighestXTally })
  | (QuestionResultBase & { type: 'recursion_filter'; tally: RecursionTally });

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
