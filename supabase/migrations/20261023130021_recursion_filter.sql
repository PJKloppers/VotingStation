-- ============================================================================
-- VotingStation :: the recursion filter
--
-- Choosing one person for a role, in rounds. A nomination round puts people
-- from a pool onto a shortlist; elimination rounds then drop the bottom of the
-- list until one person is left, or someone has a majority. The chair decides
-- how many drop each round, breaks ties at the cut, can add people from the
-- pool or withdraw them, and can end it early. See docs/plan-recursion-filter.md.
--
-- There is no fixed number of rounds. Settling round n either names a winner
-- or creates round n+1 from whoever is still in; nothing else stops it.
--
-- How it fits the rest: one question, many rounds. The question's own
-- gate_open / opened_at / closed_at mirror its current round, so everything
-- that reads gates by question (ballot_questions, realtime, question_public,
-- app_question_settled) keeps working without knowing about rounds. Those
-- columns, and current_round / phase / winner_id, are moved only by the round
-- functions: a trigger refuses direct edits.
--
-- This type always runs on its gate, whatever the ballot's mode: a round
-- without a chair has nobody to settle it.
-- ============================================================================

-- --------------------------------------------------------------- tables

create table public.questions_recursion_filter (
  id          uuid primary key default gen_random_uuid(),
  ballot_id   uuid not null references public.ballots(id) on delete cascade,
  prompt      text not null check (length(btrim(prompt)) between 1 and 300),
  description text not null default '',
  sort_order  int  not null default 0,
  enabled     boolean not null default true
              constraint questions_recursion_filter_always_enabled check (enabled),
  gate_open   boolean not null default false,
  opened_at   timestamptz,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- type specific: settings
  nominate_max       int not null default 1 check (nominate_max >= 1),
  nominate_threshold int not null default 1 check (nominate_threshold >= 1),
  pick_min           int not null default 1 check (pick_min >= 1),
  pick_max           int not null default 1 check (pick_max >= 1),
  stop_on_majority   boolean not null default true,
  allow_abstain      boolean not null default false,
  abstain_label      text not null default 'Abstain',

  -- type specific: where the race stands (moved only by the round functions)
  current_round int  not null default 0,
  phase         text not null default 'nominating'
                check (phase in ('nominating', 'eliminating', 'decided')),
  winner_id     uuid,

  check (pick_max >= pick_min)
);

create index questions_recursion_filter_ballot_idx
  on public.questions_recursion_filter (ballot_id, sort_order);
create trigger questions_recursion_filter_touch before update on public.questions_recursion_filter
  for each row execute function public.touch_updated_at();

-- The candidates. Copied from a pool, so a later edit to the pool does not
-- rewrite a race that is running.
create table public.options_recursion_filter (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions_recursion_filter(id) on delete cascade,
  label         text not null check (length(btrim(label)) between 1 and 160),
  description   text not null default '',
  enabled       boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),

  pool_entry_id  uuid references public.option_pool_entries(id) on delete set null,
  status         text not null default 'pool'
                 check (status in ('pool', 'in', 'dropped', 'withdrawn', 'winner')),
  joined_round   int,
  dropped_round  int,
  added_by_chair boolean not null default false
);

create unique index options_recursion_filter_label_uniq
  on public.options_recursion_filter (question_id, lower(btrim(label)));
create index options_recursion_filter_q_idx
  on public.options_recursion_filter (question_id, sort_order);

alter table public.questions_recursion_filter
  add constraint questions_recursion_filter_winner_fkey
  foreign key (winner_id) references public.options_recursion_filter(id) on delete set null;

-- One row per round, never deleted while the race stands. Round 0 is the
-- nomination; it is created with the question.
create table public.rounds_recursion_filter (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions_recursion_filter(id) on delete cascade,
  ballot_id   uuid not null references public.ballots(id) on delete cascade,
  round_no    int  not null check (round_no >= 0),
  kind        text not null check (kind in ('nomination', 'elimination')),
  -- picks per voter in an elimination round; the nomination round uses the
  -- question's nominate_max instead
  pick_min    int not null default 1 check (pick_min >= 1),
  pick_max    int not null default 1 check (pick_max >= 1),
  drop_count  int check (drop_count >= 0),
  gate_open   boolean not null default false,
  opened_at   timestamptz,
  closed_at   timestamptz,
  settled_at  timestamptz,
  -- what the round decided, frozen when it settles
  outcome     jsonb,
  created_at  timestamptz not null default now(),

  unique (question_id, round_no),
  check ((kind = 'nomination') = (round_no = 0)),
  check (pick_max >= pick_min)
);

-- at most one round of a question is still to be settled
create unique index rounds_recursion_filter_one_unsettled
  on public.rounds_recursion_filter (question_id) where settled_at is null;
create index rounds_recursion_filter_ballot_idx
  on public.rounds_recursion_filter (ballot_id);

-- One row per pick, as votes_highest_x, plus the round. An abstention is one
-- row with no option.
create table public.votes_recursion_filter (
  id            uuid primary key default gen_random_uuid(),
  question_id   uuid not null references public.questions_recursion_filter(id) on delete cascade,
  ballot_id     uuid not null references public.ballots(id) on delete cascade,
  voter_key     text not null,
  token_id      uuid references public.ballot_tokens(id) on delete set null,
  submission_id uuid not null,
  weight        int  not null default 1,
  valid         boolean not null default true,
  created_at    timestamptz not null default now(),

  -- type specific
  round_no      int  not null,
  option_id     uuid references public.options_recursion_filter(id) on delete cascade,
  abstain       boolean not null default false,

  check ((option_id is not null) <> abstain)
);

create unique index votes_recursion_filter_one_per_voter_option
  on public.votes_recursion_filter (question_id, round_no, voter_key, option_id)
  where valid and option_id is not null;
create unique index votes_recursion_filter_one_abstain
  on public.votes_recursion_filter (question_id, round_no, voter_key)
  where valid and abstain;
create index votes_recursion_filter_tally_idx
  on public.votes_recursion_filter (question_id, round_no) where valid;
create index votes_recursion_filter_ballot_idx
  on public.votes_recursion_filter (ballot_id);

-- --------------------------------------------------- engine-only columns

-- The round functions set this for their own transaction; the guard lets
-- through only what they do.
create function app.rf_engine() returns void
language sql set search_path = public as $$
  select set_config('app.rf_engine', 'on', true);
$$;

create function app.rf_guard_question() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.rf_engine', true), '') = 'on' then return new; end if;

  if tg_op = 'INSERT' then
    new.gate_open := false;  new.opened_at := null;  new.closed_at := null;
    new.current_round := 0;  new.phase := 'nominating';  new.winner_id := null;
    return new;
  end if;

  if (new.gate_open, new.opened_at, new.closed_at, new.current_round, new.phase, new.winner_id)
     is distinct from
     (old.gate_open, old.opened_at, old.closed_at, old.current_round, old.phase, old.winner_id)
  then
    raise exception 'A recursion filter is moved on with its round controls, not edited directly.'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger questions_recursion_filter_guard
  before insert or update on public.questions_recursion_filter
  for each row execute function app.rf_guard_question();

create function app.rf_first_round() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.rounds_recursion_filter (question_id, ballot_id, round_no, kind)
  values (new.id, new.ballot_id, 0, 'nomination');
  return new;
end $$;

create trigger questions_recursion_filter_first_round
  after insert on public.questions_recursion_filter
  for each row execute function app.rf_first_round();

-- Has the race begun? Before it has, the candidate list is the organizer's to
-- edit like any option list; after, it moves only through the round functions.
create function app.rf_started(p_question uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.rounds_recursion_filter r
     where r.question_id = p_question
       and (r.round_no > 0 or r.opened_at is not null or r.settled_at is not null));
$$;

-- --------------------------------------------------------------- registry

insert into public.question_types (key, name, description, question_table, option_table, vote_table, sort_order)
values ('recursion_filter', 'Recursion filter',
        'One person for a role, in rounds. Nominate from a pool, then drop the lowest each round until one is left.',
        'questions_recursion_filter', 'options_recursion_filter', 'votes_recursion_filter', 4);

create or replace view public.ballot_questions
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
    from public.questions_highest_x
  union all
  select id, ballot_id, 'recursion_filter', prompt, description,
         sort_order, enabled, gate_open, opened_at, closed_at, created_at
    from public.questions_recursion_filter;

-- ------------------------------------------------------- security: RLS

alter table public.questions_recursion_filter enable row level security;
create policy questions_recursion_filter_read on public.questions_recursion_filter
  for select using (app.ballot_readable(ballot_id));
create policy questions_recursion_filter_write on public.questions_recursion_filter
  for all to authenticated
  using (app.owns_ballot(ballot_id)) with check (app.owns_ballot(ballot_id));
revoke truncate, references, trigger, maintain
  on public.questions_recursion_filter from anon, authenticated;

alter table public.options_recursion_filter enable row level security;
create policy options_recursion_filter_read on public.options_recursion_filter
  for select using (exists (
    select 1 from public.questions_recursion_filter q
     where q.id = question_id and app.ballot_readable(q.ballot_id)));
-- editable by the owner only until the race begins
create policy options_recursion_filter_write on public.options_recursion_filter
  for all to authenticated
  using (exists (select 1 from public.questions_recursion_filter q
                  where q.id = question_id and app.owns_ballot(q.ballot_id))
         and not app.rf_started(question_id))
  with check (exists (select 1 from public.questions_recursion_filter q
                  where q.id = question_id and app.owns_ballot(q.ballot_id))
         and not app.rf_started(question_id));
-- and only the ordinary option columns: status and rounds are the engine's
revoke all on public.options_recursion_filter from anon, authenticated;
grant select on public.options_recursion_filter to anon, authenticated;
grant insert (question_id, label, description, sort_order, enabled)
  on public.options_recursion_filter to authenticated;
grant update (label, description, sort_order, enabled)
  on public.options_recursion_filter to authenticated;
grant delete on public.options_recursion_filter to authenticated;

alter table public.rounds_recursion_filter enable row level security;
create policy rounds_recursion_filter_read on public.rounds_recursion_filter
  for select using (app.ballot_readable(ballot_id));
revoke all on public.rounds_recursion_filter from anon, authenticated;
grant select on public.rounds_recursion_filter to anon, authenticated;

alter table public.votes_recursion_filter enable row level security;
create policy votes_recursion_filter_read on public.votes_recursion_filter
  for select using (
    app.owns_ballot(ballot_id) or exists (
      select 1 from public.questions_recursion_filter q
       where q.id = question_id and app.question_public(q.ballot_id, q.gate_open)));
revoke all on public.votes_recursion_filter from anon, authenticated;
-- voter_key is left out, as on every vote table (20260913093349)
grant select (id, question_id, ballot_id, token_id, submission_id, weight, valid, created_at,
              round_no, option_id, abstain)
  on public.votes_recursion_filter to anon, authenticated;

alter publication supabase_realtime add table
  public.questions_recursion_filter, public.options_recursion_filter,
  public.rounds_recursion_filter, public.votes_recursion_filter;

-- ------------------------------------------------------------ the count

-- Who can be voted for in round n: the pool in the nomination round, and
-- after that whoever is in and joined by this round.
create function app.rf_eligible(p_question uuid, p_round int)
returns setof public.options_recursion_filter
language sql stable security definer set search_path = public as $$
  select o.* from public.options_recursion_filter o
   where o.question_id = p_question and o.enabled
     and case when p_round = 0 then o.status = 'pool'
              else o.status = 'in' and coalesce(o.joined_round, 0) <= p_round end;
$$;

-- The count of one round. A settled round returns what it decided, frozen;
-- the round still running is counted live, and carries what the chair's
-- current drop count would do.
create function public.tally_recursion_filter(p_question uuid, p_round int default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  v_options jsonb;
  v_voters int; v_ballots int; v_abstain int;
  v_pick_min int; v_pick_max int; v_eligible int;
  v_top int := 0; v_leaders int := 0; v_majority uuid; v_n int;
  v_asc uuid[]; v_votes int[];
  v_cut int; v_below uuid[] := '{}'; v_equal uuid[] := '{}';
  v_drop uuid[] := '{}'; v_tied uuid[] := '{}'; v_tie_k int := 0;
  i int;
begin
  select * into q from public.questions_recursion_filter where id = p_question;
  if not found then return null; end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = coalesce(p_round, q.current_round);
  if not found then return null; end if;

  if r.settled_at is not null and r.outcome ? 'tally' then
    return r.outcome -> 'tally';
  end if;

  -- voters in this round: each counts once, at their weight
  select count(*)::int,
         coalesce(sum(w) filter (where not ab), 0)::int,
         coalesce(sum(w) filter (where ab), 0)::int
    into v_voters, v_ballots, v_abstain
    from (select v.voter_key, max(v.weight) as w, bool_or(v.abstain) as ab
            from public.votes_recursion_filter v
           where v.question_id = q.id and v.round_no = r.round_no and v.valid
           group by v.voter_key) s;

  select count(*)::int into v_eligible from app.rf_eligible(q.id, r.round_no);

  if r.kind = 'nomination' then
    v_pick_min := 1;  v_pick_max := least(q.nominate_max, greatest(v_eligible, 1));
  else
    v_pick_min := least(r.pick_min, greatest(v_eligible, 1));
    v_pick_max := least(r.pick_max, greatest(v_eligible, 1));
  end if;

  -- every candidate in this round with their count, lowest first
  select coalesce(array_agg(c.id order by c.votes, c.label), '{}'),
         coalesce(array_agg(c.votes order by c.votes, c.label), '{}')
    into v_asc, v_votes
    from (select e.id, e.label,
                 coalesce((select sum(v.weight) from public.votes_recursion_filter v
                            where v.option_id = e.id and v.round_no = r.round_no and v.valid), 0)::int as votes
            from app.rf_eligible(q.id, r.round_no) e) c;

  v_n := coalesce(array_length(v_asc, 1), 0);
  if v_n > 0 then
    v_top := v_votes[v_n];
    select count(*) into v_leaders from unnest(v_votes) x where x = v_top and v_top > 0;
    if v_leaders = 1 and v_top * 2 > v_ballots then
      v_majority := v_asc[v_n];
    end if;
  end if;

  -- the cut: the bottom drop_count, lowest first
  if r.kind = 'elimination' and coalesce(r.drop_count, 0) > 0 and r.drop_count <= v_n then
    v_cut := v_votes[r.drop_count];
    for i in 1 .. v_n loop
      if v_votes[i] < v_cut then v_below := v_below || v_asc[i];
      elsif v_votes[i] = v_cut then v_equal := v_equal || v_asc[i];
      end if;
    end loop;
    v_tie_k := r.drop_count - coalesce(array_length(v_below, 1), 0);
    if v_tie_k = coalesce(array_length(v_equal, 1), 0) then
      v_drop := v_below || v_equal;  v_tie_k := 0;
    else
      v_drop := v_below;  v_tied := v_equal;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id, 'label', e.label, 'description', e.description,
           'votes', x.votes,
           'share', case when v_ballots > 0 then round(x.votes::numeric / v_ballots, 4) else 0 end,
           'qualifies', r.kind = 'nomination' and x.votes >= q.nominate_threshold,
           'drops', e.id = any (v_drop),
           'tied', e.id = any (v_tied))
         order by x.votes desc, e.label), '[]'::jsonb)
    into v_options
    from app.rf_eligible(q.id, r.round_no) e
    join unnest(v_asc, v_votes) as x(id, votes) on x.id = e.id;

  return jsonb_build_object(
    'round', r.round_no,
    'kind', r.kind,
    'gate_open', r.gate_open,
    'opened', r.opened_at is not null,
    'settled', false,
    'voters', v_voters,
    'ballots', v_ballots,
    'abstain', v_abstain,
    'pick_min', v_pick_min,
    'pick_max', v_pick_max,
    'threshold', case when r.kind = 'nomination' then q.nominate_threshold end,
    'drop_count', r.drop_count,
    'stop_on_majority', q.stop_on_majority,
    'majority', to_jsonb(v_majority),
    'drop', to_jsonb(v_drop),
    'tied', to_jsonb(v_tied),
    'tie_drop_count', v_tie_k,
    'options', v_options);
end $$;

-- The whole race: where it stands, who is where, and every round so far.
create function public.tally_recursion_filter_race(p_question uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'phase', q.phase,
    'current_round', q.current_round,
    'stop_on_majority', q.stop_on_majority,
    'nominate_threshold', q.nominate_threshold,
    'winner', (select jsonb_build_object('id', o.id, 'label', o.label)
                 from public.options_recursion_filter o where o.id = q.winner_id),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'label', o.label, 'description', o.description,
               'status', o.status, 'joined_round', o.joined_round,
               'dropped_round', o.dropped_round, 'added_by_chair', o.added_by_chair)
             order by o.sort_order, o.label)
        from public.options_recursion_filter o where o.question_id = q.id), '[]'::jsonb),
    'rounds', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'round', r.round_no, 'kind', r.kind,
                 'settled', r.settled_at is not null,
                 'drop_count', r.drop_count,
                 'tally', public.tally_recursion_filter(q.id, r.round_no))
               || coalesce(r.outcome - 'tally', '{}'::jsonb)
             order by r.round_no)
        from public.rounds_recursion_filter r where r.question_id = q.id), '[]'::jsonb))
  from public.questions_recursion_filter q
  where q.id = p_question;
$$;

-- ------------------------------------------------------------- the gate

-- Opens or closes the current round, and mirrors it onto the question.
-- Callers check ownership.
create function app.rf_set_gate(p_question uuid, p_open boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  n int;
begin
  select * into q from public.questions_recursion_filter where id = p_question for update;
  if not found then return; end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;

  if p_open then
    if q.phase = 'decided' then
      raise exception '"%" is decided. There is no round left to open.', q.prompt;
    end if;
    select count(*) into n from app.rf_eligible(q.id, r.round_no);
    if r.kind = 'nomination' and n < 1 then
      raise exception 'There is nobody in the pool to nominate. Add people to "%" first.', q.prompt;
    end if;
    if r.kind = 'elimination' and n < 2 then
      raise exception 'Only % candidate(s) in round % of "%". End the vote with a winner, or add someone from the pool.',
        n, r.round_no, q.prompt;
    end if;
    update public.rounds_recursion_filter
       set gate_open = true, opened_at = now(), closed_at = null
     where id = r.id;
  else
    update public.rounds_recursion_filter
       set gate_open = false,
           closed_at = case when gate_open then now() else closed_at end
     where id = r.id;
  end if;

  perform app.rf_engine();
  update public.questions_recursion_filter q2
     set gate_open = r2.gate_open, opened_at = r2.opened_at, closed_at = r2.closed_at
    from public.rounds_recursion_filter r2
   where q2.id = q.id and r2.id = r.id;
end $$;

-- ----------------------------------------------------- the chair's controls

create function app.rf_question_for_chair(p_question uuid)
returns public.questions_recursion_filter
language plpgsql security definer set search_path = public as $$
declare q public.questions_recursion_filter;
begin
  select * into q from public.questions_recursion_filter where id = p_question for update;
  if not found then raise exception 'Question not found.'; end if;
  perform public.app_require_owner(q.ballot_id);
  return q;
end $$;

create function public.set_round_drop_count(p_question uuid, p_drop int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  n int;
begin
  q := app.rf_question_for_chair(p_question);
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  if r.kind <> 'elimination' then
    return jsonb_build_object('ok', false, 'error',
      'The nomination round drops nobody: it keeps everyone who reaches the threshold.');
  end if;
  select count(*) into n from app.rf_eligible(q.id, r.round_no);
  if p_drop is null or p_drop < 0 or p_drop > n - 1 then
    return jsonb_build_object('ok', false, 'error',
      format('Between 0 and %s can drop from this round. At least one person stays in.', greatest(n - 1, 0)));
  end if;
  update public.rounds_recursion_filter set drop_count = p_drop where id = r.id;
  return jsonb_build_object('ok', true, 'tally', public.tally_recursion_filter(q.id));
end $$;

create function public.set_round_picks(p_question uuid, p_min int, p_max int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
begin
  q := app.rf_question_for_chair(p_question);
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;
  if q.phase = 'decided' or r.kind <> 'elimination' then
    return jsonb_build_object('ok', false, 'error',
      'Picks per voter are set on elimination rounds. The nomination round uses the question''s nominations per voter.');
  end if;
  if r.gate_open or exists (select 1 from public.votes_recursion_filter v
                             where v.question_id = q.id and v.round_no = r.round_no and v.valid) then
    return jsonb_build_object('ok', false, 'error',
      'Picks per voter can only change before anyone has voted in this round.');
  end if;
  if p_min is null or p_max is null or p_min < 1 or p_max < p_min then
    return jsonb_build_object('ok', false, 'error', 'Picks must be at least 1, and the most no lower than the least.');
  end if;
  update public.rounds_recursion_filter set pick_min = p_min, pick_max = p_max where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- Puts someone from the pool (or someone dropped or withdrawn) into the race.
-- If the round under way has votes or is open, they join the next one: the
-- people who already voted never saw them.
create function public.add_candidate(p_question uuid, p_option uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  o public.options_recursion_filter;
  v_join int;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  select * into o from public.options_recursion_filter
   where id = p_option and question_id = q.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That person is not in this question''s pool.');
  end if;
  if o.status not in ('pool', 'dropped', 'withdrawn') then
    return jsonb_build_object('ok', false, 'error', format('%s is already in the race.', o.label));
  end if;

  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;

  if r.kind = 'nomination' then
    v_join := 1;
  elsif r.gate_open or exists (select 1 from public.votes_recursion_filter v
                                where v.question_id = q.id and v.round_no = r.round_no and v.valid) then
    v_join := r.round_no + 1;
  else
    v_join := r.round_no;
  end if;

  update public.options_recursion_filter
     set status = 'in', joined_round = v_join, dropped_round = null,
         added_by_chair = true, enabled = true
   where id = o.id;

  return jsonb_build_object(
    'ok', true, 'joins_round', v_join,
    'message', case when r.kind <> 'nomination' and v_join > r.round_no
                    then format('%s joins from round %s, because round %s is already under way.',
                                o.label, v_join, r.round_no)
                    else format('%s is in the race from round %s.', o.label, v_join) end);
end $$;

-- Takes someone out between rounds, for example when they decline.
create function public.withdraw_candidate(p_question uuid, p_option uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  o public.options_recursion_filter;
  n int;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  if q.gate_open then
    return jsonb_build_object('ok', false, 'error', 'Close the round before withdrawing anyone.');
  end if;
  select * into o from public.options_recursion_filter
   where id = p_option and question_id = q.id for update;
  if not found or o.status not in ('pool', 'in') then
    return jsonb_build_object('ok', false, 'error', 'That person is not in the race.');
  end if;
  if q.phase = 'eliminating' and o.status = 'in' then
    select count(*) into n from public.options_recursion_filter
     where question_id = q.id and status = 'in';
    if n <= 1 then
      return jsonb_build_object('ok', false, 'error',
        'They are the last one in. End the vote instead.');
    end if;
  end if;
  update public.options_recursion_filter
     set status = 'withdrawn', dropped_round = q.current_round
   where id = o.id;
  return jsonb_build_object('ok', true);
end $$;

-- Names the winner, or ends with none. Records it on the round that ends it.
create function app.rf_decide(
  q public.questions_recursion_filter, r public.rounds_recursion_filter,
  p_winner uuid, p_outcome jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_winner is not null then
    update public.options_recursion_filter set status = 'winner' where id = p_winner;
  end if;
  update public.rounds_recursion_filter
     set settled_at = now(), gate_open = false,
         outcome = p_outcome || jsonb_build_object('winner', to_jsonb(p_winner))
   where id = r.id;
  perform app.rf_engine();
  update public.questions_recursion_filter
     set phase = 'decided', winner_id = p_winner, gate_open = false
   where id = q.id;
end $$;

create function app.rf_next_round(q public.questions_recursion_filter, r public.rounds_recursion_filter, p_outcome jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.rounds_recursion_filter
     set settled_at = now(), outcome = p_outcome || '{"winner": null}'::jsonb
   where id = r.id;
  insert into public.rounds_recursion_filter
    (question_id, ballot_id, round_no, kind, pick_min, pick_max)
  values (q.id, q.ballot_id, r.round_no + 1, 'elimination', q.pick_min, q.pick_max);
  perform app.rf_engine();
  update public.questions_recursion_filter
     set current_round = r.round_no + 1, phase = 'eliminating'
   where id = q.id;
end $$;

-- Applies the round. The nomination round keeps whoever reached the
-- threshold, or the shortlist the chair names. An elimination round names a
-- majority winner (when the question stops on one), otherwise drops the
-- bottom drop_count, asking the chair to choose when the cut splits a tie.
-- One left is the winner; otherwise the next round is created.
create function public.settle_round(
  p_question uuid, p_tie_drop uuid[] default null, p_shortlist uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  t jsonb;
  v_drop uuid[]; v_tied uuid[]; v_tie_k int; v_choice uuid[];
  v_keep uuid[]; v_n int; v_left int; v_winner uuid; v_how text;
  v_dropped jsonb; v_withdrawn jsonb;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is decided.');
  end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round for update;
  if r.gate_open then
    return jsonb_build_object('ok', false, 'error', 'Close the round before settling it.');
  end if;

  t := public.tally_recursion_filter(q.id, r.round_no);

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label)), '[]'::jsonb)
    into v_withdrawn from public.options_recursion_filter
   where question_id = q.id and status = 'withdrawn' and dropped_round = r.round_no;

  -- ---------------------------------------------------------- nomination
  if r.kind = 'nomination' then
    if p_shortlist is not null then
      select coalesce(array_agg(o.id), '{}') into v_keep
        from public.options_recursion_filter o
       where o.question_id = q.id and o.id = any (p_shortlist) and o.status in ('pool', 'in');
    else
      select coalesce(array_agg((e ->> 'id')::uuid), '{}') into v_keep
        from jsonb_array_elements(t -> 'options') e
       where (e ->> 'qualifies')::boolean;
    end if;

    update public.options_recursion_filter
       set status = 'in', joined_round = 1, dropped_round = null
     where question_id = q.id and id = any (v_keep);

    select count(*) into v_n from public.options_recursion_filter
     where question_id = q.id and status = 'in';
    if v_n = 0 then
      return jsonb_build_object('ok', false, 'error',
        format('Nobody reached %s nomination(s). Lower the threshold, add people from the pool, or choose the shortlist yourself.',
               q.nominate_threshold),
        'needs', 'shortlist');
    end if;

    perform app.rf_next_round(q, r, jsonb_build_object(
      'tally', t || '{"settled": true}'::jsonb,
      'shortlist_by_chair', p_shortlist is not null,
      'shortlisted', (select jsonb_agg(jsonb_build_object('id', id, 'label', label) order by sort_order, label)
                        from public.options_recursion_filter
                       where question_id = q.id and status = 'in'),
      'withdrawn', v_withdrawn));

    return jsonb_build_object('ok', true, 'action', 'shortlisted', 'shortlisted', v_n,
      'message', case when v_n = 1
        then 'Only one person is on the shortlist. End the vote with them as winner, or add others from the pool.'
        else format('%s people go through to round 1.', v_n) end);
  end if;

  -- --------------------------------------------------------- elimination
  if q.stop_on_majority and t ->> 'majority' is not null then
    v_winner := (t ->> 'majority')::uuid;
    v_how := 'majority';
  else
    if r.drop_count is null then
      return jsonb_build_object('ok', false, 'error',
        'Set how many drop out of this round first.', 'needs', 'drop_count');
    end if;

    if r.drop_count > jsonb_array_length(t -> 'options') - 1 then
      return jsonb_build_object('ok', false, 'needs', 'drop_count',
        'error', format('%s can no longer drop: only %s are in this round, and one has to stay. Set the drop count again.',
                        r.drop_count, jsonb_array_length(t -> 'options')));
    end if;

    select coalesce(array_agg(x::uuid), '{}') into v_drop from jsonb_array_elements_text(t -> 'drop') x;
    select coalesce(array_agg(x::uuid), '{}') into v_tied from jsonb_array_elements_text(t -> 'tied') x;
    v_tie_k := (t ->> 'tie_drop_count')::int;

    if v_tie_k > 0 then
      select coalesce(array_agg(distinct c), '{}') into v_choice
        from unnest(coalesce(p_tie_drop, '{}'::uuid[])) c where c = any (v_tied);
      if coalesce(array_length(v_choice, 1), 0) <> v_tie_k then
        return jsonb_build_object('ok', false, 'needs', 'tie_break',
          'error', format('The cut falls on a tie. Choose %s of the tied candidates to drop.', v_tie_k),
          'drop_from_tie', v_tie_k,
          'tied', (select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) order by o.label)
                     from public.options_recursion_filter o where o.id = any (v_tied)));
      end if;
      v_drop := v_drop || v_choice;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', label) order by label), '[]'::jsonb)
      into v_dropped from public.options_recursion_filter where id = any (v_drop);

    update public.options_recursion_filter
       set status = 'dropped', dropped_round = r.round_no
     where question_id = q.id and id = any (v_drop);

    select count(*) into v_left from public.options_recursion_filter
     where question_id = q.id and status = 'in';
    if v_left = 1 then
      select id into v_winner from public.options_recursion_filter
       where question_id = q.id and status = 'in';
      v_how := 'last_left';
    end if;
  end if;

  if v_winner is not null then
    perform app.rf_decide(q, r, v_winner, jsonb_build_object(
      'tally', t || '{"settled": true}'::jsonb,
      'dropped', coalesce(v_dropped, '[]'::jsonb),
      'tie_broken_by_chair', coalesce(v_tie_k, 0) > 0, 'tie_choice', to_jsonb(v_choice),
      'withdrawn', v_withdrawn,
      'how', v_how));
    return jsonb_build_object('ok', true, 'action', 'decided', 'winner', v_winner, 'how', v_how,
      'message', format('%s wins%s.',
        (select label from public.options_recursion_filter where id = v_winner),
        case when v_how = 'majority' then ' with a majority' else ', the last one in' end));
  end if;

  perform app.rf_next_round(q, r, jsonb_build_object(
    'tally', t || '{"settled": true}'::jsonb,
    'dropped', coalesce(v_dropped, '[]'::jsonb),
    'tie_broken_by_chair', coalesce(v_tie_k, 0) > 0, 'tie_choice', to_jsonb(v_choice),
    'withdrawn', v_withdrawn));
  return jsonb_build_object('ok', true, 'action', 'next_round', 'round', r.round_no + 1,
    'dropped', v_dropped,
    'message', format('Round %s is ready with %s candidates.', r.round_no + 1, v_left));
end $$;

-- The chair's stop: names the winner from those still in, or ends with none.
create function public.end_recursion(p_question uuid, p_winner uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
begin
  q := app.rf_question_for_chair(p_question);
  if q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error', 'This vote is already decided.');
  end if;
  if q.gate_open then
    return jsonb_build_object('ok', false, 'error', 'Close the round before ending the vote.');
  end if;
  if p_winner is not null and not exists (
       select 1 from public.options_recursion_filter
        where id = p_winner and question_id = q.id and status = 'in') then
    return jsonb_build_object('ok', false, 'error', 'The winner has to be someone still in the race.');
  end if;
  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round for update;
  perform app.rf_decide(q, r, p_winner, jsonb_build_object(
    'tally', public.tally_recursion_filter(q.id, r.round_no) || '{"settled": true}'::jsonb,
    'ended_by_chair', true,
    'how', case when p_winner is null then 'no_winner' else 'chair' end));
  return jsonb_build_object('ok', true, 'action', 'decided', 'winner', p_winner);
end $$;

-- ------------------------------------------------------------- casting

create function public.cast_recursion_filter(
  p_ballot uuid, p_pin text, p_question uuid,
  p_options uuid[] default null, p_abstain boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.ballots;
  q public.questions_recursion_filter;
  r public.rounds_recursion_filter;
  a record;
  v_err text;
  v_sub uuid := gen_random_uuid();
  v_had boolean;
  v_chosen uuid[];
  v_count int; v_min int; v_max int; v_eligible int;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Ballot not found.'); end if;

  v_err := public.app_window_error(b);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err, 'closed', true); end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then return jsonb_build_object('ok', false, 'error', a.error); end if;

  select * into q from public.questions_recursion_filter
   where id = p_question and ballot_id = p_ballot;
  if not found then return jsonb_build_object('ok', false, 'error', 'Question not found on this ballot.'); end if;

  select * into r from public.rounds_recursion_filter
   where question_id = q.id and round_no = q.current_round;
  -- always gated, whatever the ballot's mode
  if not r.gate_open or r.settled_at is not null or q.phase = 'decided' then
    return jsonb_build_object('ok', false, 'error',
      format('Voting on "%s" is not open. Please wait for the chair.', q.prompt));
  end if;

  if coalesce(p_abstain, false) then
    if not q.allow_abstain then
      return jsonb_build_object('ok', false, 'error', 'This question does not allow abstentions.');
    end if;
    v_chosen := '{}';
  else
    select coalesce(array_agg(distinct e.id), '{}'::uuid[]) into v_chosen
      from app.rf_eligible(q.id, r.round_no) e
     where e.id = any (coalesce(p_options, '{}'::uuid[]));

    select count(*) into v_eligible from app.rf_eligible(q.id, r.round_no);
    if r.kind = 'nomination' then
      v_min := 1;  v_max := q.nominate_max;
    else
      v_min := least(r.pick_min, v_eligible);  v_max := r.pick_max;
    end if;

    v_count := coalesce(array_length(v_chosen, 1), 0);
    if (select count(distinct x) from unnest(coalesce(p_options, '{}'::uuid[])) x) > v_count then
      return jsonb_build_object('ok', false, 'error',
        'Someone you chose is no longer in this round. Please choose again.');
    end if;
    if v_count < greatest(v_min, 1) then
      return jsonb_build_object('ok', false, 'error',
        format('Please choose at least %s.', greatest(v_min, 1)));
    end if;
    if v_count > v_max then
      return jsonb_build_object('ok', false, 'error', format('Please choose at most %s.', v_max));
    end if;
  end if;

  select exists (select 1 from public.votes_recursion_filter
                  where question_id = q.id and round_no = r.round_no
                    and voter_key = a.voter_key and valid)
    into v_had;

  if v_had and not b.allow_vote_change then
    return jsonb_build_object('ok', false, 'error', b.already_voted_message);
  end if;

  if v_had then
    update public.votes_recursion_filter set valid = false
     where question_id = q.id and round_no = r.round_no and voter_key = a.voter_key and valid;
  end if;

  if coalesce(p_abstain, false) then
    insert into public.votes_recursion_filter
      (question_id, ballot_id, voter_key, token_id, submission_id, weight, round_no, option_id, abstain)
    values (q.id, p_ballot, a.voter_key,
            case when b.anonymous then null else a.token_id end,
            v_sub, a.weight, r.round_no, null, true);
  else
    insert into public.votes_recursion_filter
      (question_id, ballot_id, voter_key, token_id, submission_id, weight, round_no, option_id)
    select q.id, p_ballot, a.voter_key,
           case when b.anonymous then null else a.token_id end,
           v_sub, a.weight, r.round_no, oid
      from unnest(v_chosen) as oid;
  end if;

  perform public.app_after_vote(p_ballot, a.token_id, a.voter_key);

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_sub,
    'question_id', q.id,
    'round', r.round_no,
    'message', b.thank_you_message,
    'results', case when b.show_results_after and public.app_question_settled(b, q.gate_open)
                    then public.question_results(p_ballot, 'recursion_filter', q.id) else null end,
    'state', public.voter_state(p_ballot, p_pin, p_fingerprint)
  );
end $$;

-- ================================================= shared functions: a branch each

create or replace function app.voters_on(p_type text, p_question uuid)
returns table(voter_key text)
language sql stable security definer set search_path = public as $function$
  select distinct v.voter_key from public.votes_yes_no v
   where p_type = 'yes_no' and v.question_id = p_question and v.valid
  union
  select distinct v.voter_key from public.votes_highest_outright v
   where p_type = 'highest_outright' and v.question_id = p_question and v.valid
  union
  select distinct v.voter_key from public.votes_highest_x v
   where p_type = 'highest_x' and v.question_id = p_question and v.valid
  union
  -- the round under way only, so "12 of 40 have voted" starts again each round
  select distinct v.voter_key
    from public.votes_recursion_filter v
    join public.questions_recursion_filter q on q.id = v.question_id
   where p_type = 'recursion_filter' and v.question_id = p_question and v.valid
     and v.round_no = q.current_round;
$function$;

create or replace function public.app_questions_voted(p_ballot uuid, p_voter_key text)
returns integer
language sql stable security definer set search_path = public as $function$
  select (
      (select count(distinct question_id) from public.votes_yes_no
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
    + (select count(distinct question_id) from public.votes_highest_outright
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
    + (select count(distinct question_id) from public.votes_highest_x
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
    + (select count(distinct question_id) from public.votes_recursion_filter
        where ballot_id = p_ballot and voter_key = p_voter_key and valid)
  )::int;
$function$;

create or replace function public.app_guard_anonymity()
returns trigger
language plpgsql security definer set search_path = public as $function$
begin
  if new.anonymous is distinct from old.anonymous
     and exists (select 1 from public.votes_yes_no where ballot_id = new.id
                 union all select 1 from public.votes_highest_outright where ballot_id = new.id
                 union all select 1 from public.votes_highest_x where ballot_id = new.id
                 union all select 1 from public.votes_recursion_filter where ballot_id = new.id)
  then
    raise exception 'Anonymity cannot be changed once votes have been cast.';
  end if;
  return new;
end $function$;

create or replace function app.delete_votes_with_token()
returns trigger
language plpgsql security definer set search_path = public as $function$
declare k text;
begin
  -- Computed before the row goes; the salt lives on the ballot, and anonymity
  -- cannot change once a vote exists, so this key is the one that was stored.
  k := public.app_voter_key(old.ballot_id, old.pin);

  delete from public.votes_yes_no
   where ballot_id = old.ballot_id and voter_key = k;
  delete from public.votes_highest_outright
   where ballot_id = old.ballot_id and voter_key = k;
  delete from public.votes_highest_x
   where ballot_id = old.ballot_id and voter_key = k;
  -- a settled round keeps its frozen count; only the votes go
  delete from public.votes_recursion_filter
   where ballot_id = old.ballot_id and voter_key = k;

  return old;
end $function$;

create or replace function public.set_gate(
  p_ballot uuid, p_type text, p_question uuid, p_open boolean, p_only boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $function$
begin
  perform public.app_require_owner(p_ballot);
  if p_only then
    perform public.close_all_gates(p_ballot);
  end if;

  if p_type = 'yes_no' then
    update public.questions_yes_no
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  elsif p_type = 'highest_outright' then
    update public.questions_highest_outright
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  elsif p_type = 'highest_x' then
    update public.questions_highest_x
       set gate_open = p_open,
           opened_at = case when p_open then now() else opened_at end,
           closed_at = case when p_open then null else now() end
     where id = p_question and ballot_id = p_ballot;
  elsif p_type = 'recursion_filter' then
    if exists (select 1 from public.questions_recursion_filter
                where id = p_question and ballot_id = p_ballot) then
      perform app.rf_set_gate(p_question, p_open);
    end if;
  else
    raise exception 'Unknown question type %', p_type;
  end if;

  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.close_all_gates(p_ballot uuid)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare v_q uuid;
begin
  perform public.app_require_owner(p_ballot);
  update public.questions_yes_no
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  update public.questions_highest_outright
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  update public.questions_highest_x
     set gate_open = false, closed_at = now() where ballot_id = p_ballot and gate_open;
  for v_q in select id from public.questions_recursion_filter
              where ballot_id = p_ballot and gate_open loop
    perform app.rf_set_gate(v_q, false);
  end loop;
  return jsonb_build_object('ok', true);
end $function$;

-- "Next" walks a recursion filter's rounds before it moves on: an open round
-- closes and waits to be settled; a settled one opens the next round; only a
-- decided race lets the ballot go on to the question after it.
create or replace function public.advance_ballot(p_ballot uuid)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  b        public.ballots;
  v_open   record;
  v_next   record;
  v_last   record;
  rq       public.questions_recursion_filter;
  rr       public.rounds_recursion_filter;
  v_had    boolean := false;
  v_voted  int;
  v_due    int;
begin
  perform public.app_require_owner(p_ballot);
  select * into b from public.ballots where id = p_ballot;

  select q.* into v_open
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled and q.gate_open
   order by q.sort_order, q.prompt
   limit 1;
  v_had := found;

  -- Before anything closes: is the room finished with it?
  if v_had and b.require_all_pins then
    v_due   := app.expected_on(p_ballot, v_open.question_type, v_open.id);
    v_voted := app.voted_on(v_open.question_type, v_open.id);
    if v_due > 0 and v_voted < v_due then
      return jsonb_build_object(
        'ok', false,
        'error', format('%s of %s PINs have voted on "%s". This ballot waits for all of them.',
                        v_voted, v_due, v_open.prompt),
        'waiting', jsonb_build_object('voted', v_voted, 'eligible', v_due));
    end if;
  end if;

  -- An open round closes and the ballot stays on its question.
  if v_had and v_open.question_type = 'recursion_filter' then
    perform public.close_all_gates(p_ballot);
    select * into rq from public.questions_recursion_filter where id = v_open.id;
    return jsonb_build_object(
      'ok', true, 'action', 'round_closed', 'round', rq.current_round,
      'closed', jsonb_build_object('id', v_open.id, 'prompt', v_open.prompt),
      'message', format('Round %s of "%s" is closed. Settle it to go on.', rq.current_round, v_open.prompt));
  end if;

  -- Whatever the state was, at most one gate is open when this returns.
  perform public.close_all_gates(p_ballot);

  if not v_had then
    -- Where is the chair? If the last thing closed was a recursion filter,
    -- carry on with it, or carry on after it.
    select q.* into v_last
      from public.ballot_questions q
     where q.ballot_id = p_ballot and q.enabled and q.closed_at is not null
     order by q.closed_at desc
     limit 1;

    if found and v_last.question_type = 'recursion_filter' then
      select * into rq from public.questions_recursion_filter where id = v_last.id;
      if rq.phase <> 'decided' then
        select * into rr from public.rounds_recursion_filter
         where question_id = rq.id and round_no = rq.current_round;
        if rr.opened_at is not null then
          return jsonb_build_object('ok', false, 'needs', 'settle',
            'error', format('Round %s of "%s" has closed but is not settled. Settle it first.',
                            rq.current_round, rq.prompt));
        end if;
        perform public.set_gate(p_ballot, 'recursion_filter', rq.id, true, false);
        return jsonb_build_object(
          'ok', true, 'action', 'opened', 'round', rq.current_round,
          'opened', jsonb_build_object('id', rq.id, 'prompt', rq.prompt));
      end if;

      select q.* into v_next
        from public.ballot_questions q
       where q.ballot_id = p_ballot and q.enabled
         and (q.sort_order, q.prompt) > (v_last.sort_order, v_last.prompt)
       order by q.sort_order, q.prompt
       limit 1;
      if not found then
        update public.ballots set status = 'closed' where id = p_ballot;
        return jsonb_build_object(
          'ok', true, 'action', 'finished',
          'closed', jsonb_build_object('id', v_last.id, 'prompt', v_last.prompt));
      end if;
      perform public.set_gate(p_ballot, v_next.question_type, v_next.id, true, false);
      return jsonb_build_object(
        'ok', true, 'action', 'advanced',
        'closed', jsonb_build_object('id', v_last.id, 'prompt', v_last.prompt),
        'opened', jsonb_build_object('id', v_next.id, 'prompt', v_next.prompt));
    end if;

    select q.* into v_next
      from public.ballot_questions q
     where q.ballot_id = p_ballot and q.enabled
     order by q.sort_order, q.prompt
     limit 1;

    if not found then
      return jsonb_build_object('ok', false, 'error', 'This ballot has no questions on it.');
    end if;

    perform public.set_gate(p_ballot, v_next.question_type, v_next.id, true, false);
    return jsonb_build_object(
      'ok', true, 'action', 'opened',
      'opened', jsonb_build_object('id', v_next.id, 'prompt', v_next.prompt));
  end if;

  select q.* into v_next
    from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled
     and (q.sort_order, q.prompt) > (v_open.sort_order, v_open.prompt)
   order by q.sort_order, q.prompt
   limit 1;

  if not found then
    update public.ballots set status = 'closed' where id = p_ballot;
    return jsonb_build_object(
      'ok', true, 'action', 'finished',
      'closed', jsonb_build_object('id', v_open.id, 'prompt', v_open.prompt));
  end if;

  perform public.set_gate(p_ballot, v_next.question_type, v_next.id, true, false);
  return jsonb_build_object(
    'ok', true, 'action', 'advanced',
    'closed', jsonb_build_object('id', v_open.id, 'prompt', v_open.prompt),
    'opened', jsonb_build_object('id', v_next.id, 'prompt', v_next.prompt));
end $function$;

-- Clearing a ballot's votes starts its races again from the nomination: a
-- settled round whose votes are gone would be a result with nothing under it.
create or replace function public.clear_ballot_votes(p_ballot uuid)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare n int := 0; c int;
begin
  perform public.app_require_owner(p_ballot);
  update public.votes_yes_no set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_outright set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_highest_x set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;
  update public.votes_recursion_filter set valid = false where ballot_id = p_ballot and valid;
  get diagnostics c = row_count; n := n + c;

  perform app.rf_engine();
  update public.questions_recursion_filter
     set winner_id = null, current_round = 0, phase = 'nominating',
         gate_open = false, opened_at = null, closed_at = null
   where ballot_id = p_ballot;
  delete from public.rounds_recursion_filter where ballot_id = p_ballot and round_no > 0;
  update public.rounds_recursion_filter
     set gate_open = false, opened_at = null, closed_at = null, settled_at = null,
         outcome = null, drop_count = null
   where ballot_id = p_ballot and round_no = 0;
  update public.options_recursion_filter o
     set status = 'pool', joined_round = null, dropped_round = null, added_by_chair = false
    from public.questions_recursion_filter q
   where q.id = o.question_id and q.ballot_id = p_ballot;

  update public.ballot_tokens set questions_voted = 0, last_vote_at = null
   where ballot_id = p_ballot;
  return jsonb_build_object('ok', true, 'voided', n);
end $function$;

-- Resetting a PIN voids its vote in rounds still under way. A settled round
-- has already decided who goes on; its count stays as it was.
create or replace function public.reset_token(p_token uuid, p_question uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  t public.ballot_tokens;
  k text;
  n int := 0;
  c int;
begin
  select * into t from public.ballot_tokens where id = p_token;
  if not found then raise exception 'PIN not found.'; end if;
  perform public.app_require_owner(t.ballot_id);

  k := public.app_voter_key(t.ballot_id, t.pin);

  update public.votes_yes_no set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.votes_highest_outright set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.votes_highest_x set valid = false
   where ballot_id = t.ballot_id and voter_key = k and valid
     and (p_question is null or question_id = p_question);
  get diagnostics c = row_count; n := n + c;

  update public.votes_recursion_filter v set valid = false
    from public.rounds_recursion_filter r
   where v.ballot_id = t.ballot_id and v.voter_key = k and v.valid
     and (p_question is null or v.question_id = p_question)
     and r.question_id = v.question_id and r.round_no = v.round_no
     and r.settled_at is null;
  get diagnostics c = row_count; n := n + c;

  update public.ballot_tokens
     set questions_voted = public.app_questions_voted(t.ballot_id, k),
         last_vote_at = case when public.app_questions_voted(t.ballot_id, k) = 0
                             then null else last_vote_at end
   where id = p_token;

  return jsonb_build_object('ok', true, 'voided', n);
end $function$;

create or replace function public.question_results(p_ballot uuid, p_type text, p_question uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $function$
declare
  r jsonb;
  q record;
  v_mine boolean := app.owns_ballot(p_ballot);
begin
  if p_type = 'yes_no' then
    select id, prompt, description, gate_open into q
      from public.questions_yes_no where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_yes_no(q.id)); end if;

  elsif p_type = 'highest_outright' then
    select id, prompt, description, gate_open into q
      from public.questions_highest_outright where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_highest_outright(q.id)); end if;

  elsif p_type = 'highest_x' then
    select id, prompt, description, gate_open into q
      from public.questions_highest_x where id = p_question and ballot_id = p_ballot;
    if found then
      r := jsonb_build_object('tally', case
        when v_mine then public.tally_highest_x(q.id)
        else public.tally_highest_x_public(q.id)
      end);
    end if;

  elsif p_type = 'recursion_filter' then
    select id, prompt, description, gate_open into q
      from public.questions_recursion_filter where id = p_question and ballot_id = p_ballot;
    if found then r := jsonb_build_object('tally', public.tally_recursion_filter_race(q.id)); end if;
  end if;

  if r is null then return 'null'::jsonb; end if;

  return r || jsonb_build_object(
    'id', q.id, 'type', p_type, 'prompt', q.prompt,
    'description', q.description, 'gate_open', q.gate_open,
    -- how much of the room this question is still waiting on
    'voted', app.voted_on(p_type, p_question),
    'expected', app.expected_on(p_ballot, p_type, p_question));
end $function$;

create or replace function public.app_settled_results(b ballots, p_voter_key text)
returns jsonb
language plpgsql stable security definer set search_path = public as $function$
declare v jsonb;
begin
  select * into b from public.ballots where id = b.id;
  if not found then return '[]'::jsonb; end if;
  if not b.show_results_after then return '[]'::jsonb; end if;

  with answered as (
    select q.id, 'yes_no'::text as t, q.sort_order, q.prompt, q.gate_open
      from public.questions_yes_no q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_yes_no v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
    union all
    select q.id, 'highest_outright', q.sort_order, q.prompt, q.gate_open
      from public.questions_highest_outright q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_highest_outright v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
    union all
    select q.id, 'highest_x', q.sort_order, q.prompt, q.gate_open
      from public.questions_highest_x q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_highest_x v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
    union all
    select q.id, 'recursion_filter', q.sort_order, q.prompt, q.gate_open
      from public.questions_recursion_filter q
     where q.ballot_id = b.id and q.enabled
       and exists (select 1 from public.votes_recursion_filter v
                    where v.question_id = q.id and v.voter_key = p_voter_key and v.valid)
  )
  select coalesce(jsonb_agg(public.question_results(b.id, a.t, a.id)
                            order by a.sort_order, a.prompt), '[]'::jsonb)
    into v
    from answered a
   where public.app_question_settled(b, a.gate_open);

  return v;
end $function$;

-- Copying a pool into a recursion filter adds whoever is not there already,
-- so the chair can top up from a pool that grew after the race began.
create or replace function public.copy_pool_into_question(p_pool uuid, p_type text, p_question uuid)
returns integer
language plpgsql security definer set search_path = public as $function$
declare v_ballot uuid; v_from int; v_added int;
begin
  if not app.owns_pool(p_pool) then
    raise exception 'Not your option pool.' using errcode = '42501';
  end if;

  if p_type = 'highest_outright' then
    select ballot_id into v_ballot from public.questions_highest_outright where id = p_question;
  elsif p_type = 'highest_x' then
    select ballot_id into v_ballot from public.questions_highest_x where id = p_question;
  elsif p_type = 'recursion_filter' then
    select ballot_id into v_ballot from public.questions_recursion_filter where id = p_question;
  else
    raise exception 'A % question has no options to copy into.', p_type using errcode = '22023';
  end if;

  if v_ballot is null or not app.owns_ballot(v_ballot) then
    raise exception 'Not your question.' using errcode = '42501';
  end if;

  if p_type = 'highest_outright' then
    select coalesce(max(sort_order), 0) into v_from
      from public.options_highest_outright where question_id = p_question;

    insert into public.options_highest_outright (question_id, label, description, sort_order)
    select p_question, e.label, e.description,
           v_from + row_number() over (order by e.sort_order, e.label)
      from public.option_pool_entries e where e.pool_id = p_pool;
  elsif p_type = 'highest_x' then
    select coalesce(max(sort_order), 0) into v_from
      from public.options_highest_x where question_id = p_question;

    insert into public.options_highest_x (question_id, label, description, sort_order)
    select p_question, e.label, e.description,
           v_from + row_number() over (order by e.sort_order, e.label)
      from public.option_pool_entries e where e.pool_id = p_pool;
  else
    select coalesce(max(sort_order), 0) into v_from
      from public.options_recursion_filter where question_id = p_question;

    insert into public.options_recursion_filter
      (question_id, label, description, sort_order, pool_entry_id)
    select p_question, left(btrim(e.label), 160), e.description,
           v_from + row_number() over (order by e.sort_order, e.label), e.id
      from public.option_pool_entries e
     where e.pool_id = p_pool
       and not exists (select 1 from public.options_recursion_filter o
                        where o.question_id = p_question
                          and lower(btrim(o.label)) = lower(btrim(left(btrim(e.label), 160))))
    on conflict do nothing;
  end if;

  get diagnostics v_added = row_count;
  return v_added;
end $function$;

create or replace function public.voter_state(p_ballot uuid, p_pin text, p_fingerprint text default null)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  b public.ballots;
  a record;
  v_err text;
  v_questions jsonb;
  v_total int;
begin
  select * into b from public.ballots where id = p_ballot;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ballot not found.');
  end if;

  v_err := public.app_window_error(b);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err, 'closed', true);
  end if;

  select * into a from public.app_authorise(p_ballot, p_pin, p_fingerprint);
  if a.error is not null then
    return jsonb_build_object('ok', false, 'error', a.error);
  end if;

  with live as (
    select q.id, 'yes_no'::text as question_type, q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'yes_label', q.yes_label, 'no_label', q.no_label,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label,
             'pass_num', q.pass_num, 'pass_den', q.pass_den,
             'threshold_strict', q.threshold_strict
           ) as config,
           '[]'::jsonb as options,
           (select to_jsonb(v.choice) from public.votes_yes_no v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid
             limit 1) as previous
      from public.questions_yes_no q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    select q.id, 'highest_outright', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'require_majority', q.require_majority,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from public.options_highest_outright o
              where o.question_id = q.id and o.enabled), '[]'::jsonb),
           (select case when v.abstain then to_jsonb('abstain'::text) else to_jsonb(v.option_id) end
              from public.votes_highest_outright v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid
             limit 1)
      from public.questions_highest_outright q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    select q.id, 'highest_x', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'select_min', q.select_min, 'select_max', q.select_max,
             'winner_count', q.winner_count
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from public.options_highest_x o
              where o.question_id = q.id and o.enabled), '[]'::jsonb),
           (select jsonb_agg(v.option_id) from public.votes_highest_x v
             where v.question_id = q.id and v.voter_key = a.voter_key and v.valid)
      from public.questions_highest_x q
     where q.ballot_id = p_ballot and q.enabled
       and (b.mode = 'open' or q.gate_open)
    union all
    -- a recursion filter shows only while a round is open, whatever the mode
    select q.id, 'recursion_filter', q.prompt, q.description,
           q.sort_order, q.gate_open,
           jsonb_build_object(
             'round', r.round_no, 'kind', r.kind,
             'pick_min', case when r.kind = 'nomination' then 1
                              else least(r.pick_min, (select count(*) from app.rf_eligible(q.id, r.round_no))) end,
             'pick_max', case when r.kind = 'nomination' then q.nominate_max else r.pick_max end,
             'allow_abstain', q.allow_abstain, 'abstain_label', q.abstain_label
           ),
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', o.id, 'label', o.label, 'description', o.description)
                      order by o.sort_order, o.label)
               from app.rf_eligible(q.id, r.round_no) o), '[]'::jsonb),
           (select case when bool_or(v.abstain) then to_jsonb('abstain'::text)
                        else jsonb_agg(v.option_id) end
              from public.votes_recursion_filter v
             where v.question_id = q.id and v.round_no = r.round_no
               and v.voter_key = a.voter_key and v.valid
            having count(*) > 0)
      from public.questions_recursion_filter q
      join public.rounds_recursion_filter r
        on r.question_id = q.id and r.round_no = q.current_round
     where q.ballot_id = p_ballot and q.enabled and r.gate_open
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'type', question_type, 'prompt', prompt,
           'description', description, 'gate_open', gate_open,
           'config', config, 'options', options,
           'voted', previous is not null,
           'previous', coalesce(previous, 'null'::jsonb)
         ) order by sort_order, prompt), '[]'::jsonb)
    into v_questions
    from live;

  select count(*) into v_total from public.ballot_questions q
   where q.ballot_id = p_ballot and q.enabled;

  return jsonb_build_object(
    'ok', true,
    'ballot', jsonb_build_object(
      'id', b.id, 'title', b.title, 'description', b.description,
      'mode', b.mode, 'allow_vote_change', b.allow_vote_change,
      'require_all', b.require_all, 'show_results_after', b.show_results_after,
      'waiting_message', b.waiting_message, 'all_done_message', b.all_done_message,
      'already_voted_message', b.already_voted_message,
      'lobby_refresh_seconds', b.lobby_refresh_seconds,
      'org_logo_path', app.ballot_logo_path(b.id)
    ),
    'voter', jsonb_build_object('weight', a.weight),
    'progress', jsonb_build_object(
      'voted', public.app_questions_voted(p_ballot, a.voter_key),
      'open_now', jsonb_array_length(v_questions),
      'total', v_total
    ),
    'questions', v_questions,
    -- what this voter has answered that is now finished, with its count
    'settled', public.app_settled_results(b, a.voter_key)
  );
end $function$;

-- ------------------------------------------------------------- who may call

revoke all on function app.rf_engine() from public, anon, authenticated;
revoke all on function app.rf_guard_question() from public, anon, authenticated;
revoke all on function app.rf_first_round() from public, anon, authenticated;
revoke all on function app.rf_eligible(uuid, int) from public, anon, authenticated;
revoke all on function app.rf_set_gate(uuid, boolean) from public, anon, authenticated;
revoke all on function app.rf_question_for_chair(uuid) from public, anon, authenticated;
revoke all on function app.rf_decide(public.questions_recursion_filter, public.rounds_recursion_filter, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.rf_next_round(public.questions_recursion_filter, public.rounds_recursion_filter, jsonb) from public, anon, authenticated;
-- the RLS policy on options calls this as the caller
revoke all on function app.rf_started(uuid) from public;
grant execute on function app.rf_started(uuid) to authenticated;

revoke all on function public.tally_recursion_filter(uuid, int) from public, anon, authenticated;
revoke all on function public.tally_recursion_filter_race(uuid) from public, anon, authenticated;

revoke all on function public.cast_recursion_filter(uuid, text, uuid, uuid[], boolean, text) from public;
grant execute on function public.cast_recursion_filter(uuid, text, uuid, uuid[], boolean, text) to anon, authenticated;

revoke all on function public.settle_round(uuid, uuid[], uuid[]) from public, anon;
revoke all on function public.end_recursion(uuid, uuid) from public, anon;
revoke all on function public.set_round_drop_count(uuid, int) from public, anon;
revoke all on function public.set_round_picks(uuid, int, int) from public, anon;
revoke all on function public.add_candidate(uuid, uuid) from public, anon;
revoke all on function public.withdraw_candidate(uuid, uuid) from public, anon;
grant execute on function public.settle_round(uuid, uuid[], uuid[]) to authenticated;
grant execute on function public.end_recursion(uuid, uuid) to authenticated;
grant execute on function public.set_round_drop_count(uuid, int) to authenticated;
grant execute on function public.set_round_picks(uuid, int, int) to authenticated;
grant execute on function public.add_candidate(uuid, uuid) to authenticated;
grant execute on function public.withdraw_candidate(uuid, uuid) to authenticated;
