-- ============================================================================
-- VotingStation :: core
--
-- Multi-tenant token voting.
--
--   auth.users  1--*  organizations  1--*  ballots  1--*  questions_<type>
--                                            |                  |
--                                            +--* ballot_tokens  +--* options_<type>
--                                                                +--* votes_<type>
--
-- A signed-in user owns organizations; an organization owns ballots. Voters
-- are never users -- they hold a 6-digit PIN that is valid only on one ballot.
-- Results are public; PINs are not.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- utilities

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ------------------------------------------------------------ organizations

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  slug        text not null unique
              check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name        text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '',
  contact     text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index organizations_owner_idx on public.organizations (owner_id);

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();

comment on table public.organizations is
  'An organizer account. Owned by an auth user; a user may own several.';

-- ------------------------------------------------------------------ ballots

create type public.ballot_mode   as enum ('gated', 'open');
create type public.ballot_status as enum ('draft', 'live', 'closed');

create table public.ballots (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  slug          text not null
                check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  title         text not null check (length(btrim(title)) between 1 and 200),
  description   text not null default '',

  -- when the ballot accepts votes
  status        public.ballot_status not null default 'draft',
  mode          public.ballot_mode   not null default 'gated',
  opens_at      timestamptz,
  closes_at     timestamptz,

  -- ballot rules
  allow_vote_change  boolean not null default false,
  require_all        boolean not null default true,   -- open mode only
  anonymous          boolean not null default true,
  show_results_after boolean not null default false,
  results_public     boolean not null default true,

  -- voter-facing copy
  intro_message        text not null default 'Enter the 6-digit PIN you were issued to open your ballot.',
  waiting_message      text not null default 'No question is open yet. Reload when the chair opens the vote.',
  all_done_message     text not null default 'You have voted on every question that is currently open.',
  thank_you_message    text not null default 'Thank you, your vote has been recorded.',
  closed_message       text not null default 'Voting is currently closed. Please check back later.',
  already_voted_message text not null default 'You have already voted on this question.',
  lobby_refresh_seconds int not null default 0 check (lobby_refresh_seconds between 0 and 3600),

  -- salt behind the pseudonymous voter key; never leaves the database
  vote_salt   uuid not null default gen_random_uuid(),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (org_id, slug),
  check (opens_at is null or closes_at is null or opens_at < closes_at)
);

create index ballots_org_idx on public.ballots (org_id);

create trigger ballots_touch before update on public.ballots
  for each row execute function public.touch_updated_at();

comment on column public.ballots.vote_salt is
  'Salt for the anonymous voter key. Readable by nobody -- see the column grants.';

-- ------------------------------------------------------------------- tokens

create type public.token_status as enum ('active', 'disabled');

create table public.ballot_tokens (
  id             uuid primary key default gen_random_uuid(),
  ballot_id      uuid not null references public.ballots(id) on delete cascade,
  pin            text not null check (pin ~ '^[0-9]{6}$'),
  label          text not null default '',
  status         public.token_status not null default 'active',
  weight         int not null default 1 check (weight > 0),
  notes          text not null default '',
  issued_at      timestamptz not null default now(),
  last_vote_at   timestamptz,
  questions_voted int not null default 0,

  unique (ballot_id, pin)
);

create index ballot_tokens_ballot_idx on public.ballot_tokens (ballot_id);

comment on table public.ballot_tokens is
  'Voting PINs. Scoped to one ballot, so the same PIN may exist on two ballots. Never readable by anon.';

-- --------------------------------------------------- question type registry

create table public.question_types (
  key            text primary key,
  name           text not null,
  description    text not null default '',
  question_table text not null,
  option_table   text,              -- null when the type needs no options
  vote_table     text not null,
  sort_order     int  not null default 0
);

comment on table public.question_types is
  'One row per supported question type. Adding a type means adding its tables, a row here, and a branch in the ballot_questions view.';

-- -------------------------------------------------- brute-force protection

create table public.pin_attempts (
  ballot_id    uuid not null references public.ballots(id) on delete cascade,
  fingerprint  text not null,
  failures     int  not null default 0,
  first_at     timestamptz not null default now(),
  locked_until timestamptz,
  primary key (ballot_id, fingerprint)
);

comment on table public.pin_attempts is
  'Failed PIN attempts per browser fingerprint. Only failures are counted, so reloading a waiting screen never locks a voter out.';
