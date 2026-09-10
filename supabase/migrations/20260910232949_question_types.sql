-- ============================================================================
-- VotingStation :: question types
--
-- Every question type owns three things: a question table, an option table
-- (unless the type has fixed answers) and a vote table whose columns match
-- exactly what that type records. Nothing is shared and nothing is generic,
-- so a new type is a new set of tables plus a row in question_types.
--
-- Every question table repeats the same block of common columns:
--
--   id, ballot_id, prompt, description, sort_order,
--   enabled, gate_open, opened_at, closed_at, created_at, updated_at
--
-- and every vote table repeats:
--
--   id, question_id, ballot_id, voter_key, token_id, submission_id,
--   valid, created_at
--
-- `voter_key` is a salted hash of the PIN when the ballot is anonymous and
-- the plain 'pin:NNNNNN' otherwise. `token_id` is filled in only on a
-- non-anonymous ballot. `valid = false` marks a superseded ballot: rows are
-- never deleted, and the tally ignores them.
-- ============================================================================

-- ============================================================== 1. YES / NO
-- A motion. One voter, one answer, from a fixed set.

create table public.questions_yes_no (
  id          uuid primary key default gen_random_uuid(),
  ballot_id   uuid not null references public.ballots(id) on delete cascade,
  prompt      text not null check (length(btrim(prompt)) between 1 and 300),
  description text not null default '',
  sort_order  int  not null default 0,
  enabled     boolean not null default true,
  gate_open   boolean not null default false,
  opened_at   timestamptz,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- type specific
  yes_label      text not null default 'Yes',
  no_label       text not null default 'No',
  allow_abstain  boolean not null default false,
  abstain_label  text not null default 'Abstain',

  -- The share of the decisive (non-abstaining) votes the Yes side must reach,
  -- held as an exact fraction so two-thirds is two-thirds and not 0.667.
  -- strict: 1/2 strict is "more than half"; 2/3 loose is "at least two thirds".
  pass_num       int not null default 1 check (pass_num >= 0),
  pass_den       int not null default 2 check (pass_den > 0),
  threshold_strict boolean not null default true,
  check (pass_num <= pass_den)
);

create index questions_yes_no_ballot_idx on public.questions_yes_no (ballot_id, sort_order);
create trigger questions_yes_no_touch before update on public.questions_yes_no
  for each row execute function public.touch_updated_at();

create type public.yes_no_choice as enum ('yes', 'no', 'abstain');

create table public.votes_yes_no (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions_yes_no(id) on delete cascade,
  ballot_id     uuid not null references public.ballots(id) on delete cascade,
  voter_key     text not null,
  token_id      uuid references public.ballot_tokens(id) on delete set null,
  submission_id uuid not null,
  weight        int  not null default 1,
  valid         boolean not null default true,
  created_at    timestamptz not null default now(),

  -- type specific
  choice        public.yes_no_choice not null
);

-- one standing answer per voter per question
create unique index votes_yes_no_one_per_voter
  on public.votes_yes_no (question_id, voter_key) where valid;
create index votes_yes_no_tally_idx on public.votes_yes_no (question_id) where valid;
create index votes_yes_no_ballot_idx on public.votes_yes_no (ballot_id);


-- =================================================== 2. HIGHEST OUTRIGHT
-- Pick one option from a list. The option with the most votes wins; when
-- require_majority is on it must also clear half of the votes cast.

create table public.questions_highest_outright (
  id          uuid primary key default gen_random_uuid(),
  ballot_id   uuid not null references public.ballots(id) on delete cascade,
  prompt      text not null check (length(btrim(prompt)) between 1 and 300),
  description text not null default '',
  sort_order  int  not null default 0,
  enabled     boolean not null default true,
  gate_open   boolean not null default false,
  opened_at   timestamptz,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- type specific
  require_majority boolean not null default false,
  allow_abstain    boolean not null default false,
  abstain_label    text not null default 'Abstain'
);

create index questions_highest_outright_ballot_idx
  on public.questions_highest_outright (ballot_id, sort_order);
create trigger questions_highest_outright_touch before update on public.questions_highest_outright
  for each row execute function public.touch_updated_at();

create table public.options_highest_outright (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions_highest_outright(id) on delete cascade,
  label       text not null check (length(btrim(label)) between 1 and 160),
  description text not null default '',
  enabled     boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create unique index options_highest_outright_label_uniq
  on public.options_highest_outright (question_id, lower(btrim(label)));
create index options_highest_outright_q_idx
  on public.options_highest_outright (question_id, sort_order);

create table public.votes_highest_outright (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions_highest_outright(id) on delete cascade,
  ballot_id     uuid not null references public.ballots(id) on delete cascade,
  voter_key     text not null,
  token_id      uuid references public.ballot_tokens(id) on delete set null,
  submission_id uuid not null,
  weight        int  not null default 1,
  valid         boolean not null default true,
  created_at    timestamptz not null default now(),

  -- type specific: exactly one option, or an abstention
  option_id     uuid references public.options_highest_outright(id) on delete cascade,
  abstain       boolean not null default false,

  check ((option_id is not null) <> abstain)
);

create unique index votes_highest_outright_one_per_voter
  on public.votes_highest_outright (question_id, voter_key) where valid;
create index votes_highest_outright_tally_idx
  on public.votes_highest_outright (question_id) where valid;
create index votes_highest_outright_ballot_idx
  on public.votes_highest_outright (ballot_id);


-- ==================================================== 3. HIGHEST X OPTIONS
-- Pick between select_min and select_max options. The top `winner_count`
-- options by vote count are declared elected.

create table public.questions_highest_x (
  id          uuid primary key default gen_random_uuid(),
  ballot_id   uuid not null references public.ballots(id) on delete cascade,
  prompt      text not null check (length(btrim(prompt)) between 1 and 300),
  description text not null default '',
  sort_order  int  not null default 0,
  enabled     boolean not null default true,
  gate_open   boolean not null default false,
  opened_at   timestamptz,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- type specific
  select_min   int not null default 1 check (select_min >= 0),
  select_max   int not null default 3 check (select_max >= 1),
  winner_count int not null default 1 check (winner_count >= 1),

  check (select_max >= select_min)
);

create index questions_highest_x_ballot_idx
  on public.questions_highest_x (ballot_id, sort_order);
create trigger questions_highest_x_touch before update on public.questions_highest_x
  for each row execute function public.touch_updated_at();

create table public.options_highest_x (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions_highest_x(id) on delete cascade,
  label       text not null check (length(btrim(label)) between 1 and 160),
  description text not null default '',
  enabled     boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create unique index options_highest_x_label_uniq
  on public.options_highest_x (question_id, lower(btrim(label)));
create index options_highest_x_q_idx
  on public.options_highest_x (question_id, sort_order);

-- One row per selection, so a voter with three picks writes three rows that
-- share a submission_id.
create table public.votes_highest_x (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions_highest_x(id) on delete cascade,
  ballot_id     uuid not null references public.ballots(id) on delete cascade,
  voter_key     text not null,
  token_id      uuid references public.ballot_tokens(id) on delete set null,
  submission_id uuid not null,
  weight        int  not null default 1,
  valid         boolean not null default true,
  created_at    timestamptz not null default now(),

  -- type specific
  option_id     uuid not null references public.options_highest_x(id) on delete cascade
);

create unique index votes_highest_x_one_per_voter_option
  on public.votes_highest_x (question_id, voter_key, option_id) where valid;
create index votes_highest_x_tally_idx
  on public.votes_highest_x (question_id) where valid;
create index votes_highest_x_ballot_idx
  on public.votes_highest_x (ballot_id);


-- ------------------------------------------------------------- the registry

insert into public.question_types (key, name, description, question_table, option_table, vote_table, sort_order)
values
  ('yes_no', 'Yes / No',
   'A motion carried or defeated. Optionally allows abstentions and a threshold above a simple majority.',
   'questions_yes_no', null, 'votes_yes_no', 1),
  ('highest_outright', 'Highest outright',
   'One choice from a list. The option with the most votes wins, optionally requiring an outright majority.',
   'questions_highest_outright', 'options_highest_outright', 'votes_highest_outright', 2),
  ('highest_x', 'Highest X options',
   'Choose several options from a list. The top X by vote count are elected.',
   'questions_highest_x', 'options_highest_x', 'votes_highest_x', 3);


-- ------------------------------------- one ordered list across every type
-- Extend this view when a type is added.

create view public.ballot_questions
with (security_invoker = true) as
  select id, ballot_id, 'yes_no'::text as question_type, prompt, description,
         sort_order, enabled, gate_open, opened_at, closed_at, created_at
    from public.questions_yes_no
  union all
  select id, ballot_id, 'highest_outright', prompt, description,
         sort_order, enabled, gate_open, opened_at, closed_at, created_at
    from public.questions_highest_outright
  union all
  select id, ballot_id, 'highest_x', prompt, description,
         sort_order, enabled, gate_open, opened_at, closed_at, created_at
    from public.questions_highest_x;

comment on view public.ballot_questions is
  'Every question on a ballot, whatever its type, in one ordered list.';
