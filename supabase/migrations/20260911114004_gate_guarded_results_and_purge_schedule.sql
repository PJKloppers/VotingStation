-- ============================================================================
-- VotingStation :: wire the gate guard in, and schedule the purge
--
-- The three cast_* functions and voter_state are long, and all that changes in
-- them is one condition and one key. Rewriting them whole here would mean four
-- more copies to keep in step with the originals, so this patches the
-- definitions in place instead -- the same edit, applied where they are.
--
-- Both halves are guarded, so running this twice changes nothing.
-- ============================================================================

do $$
declare fn text; body text;
begin
  foreach fn in array array['cast_yes_no', 'cast_highest_outright', 'cast_highest_x'] loop
    select pg_get_functiondef(p.oid) into body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;

    if position('app_question_settled' in body) = 0 then
      -- The receipt may not carry a running count. In gated mode cast_* only
      -- runs while the gate is open, so this is a tally the voter never sees
      -- until the chair closes the question.
      body := replace(body,
        '''results'', case when b.show_results_after',
        '''results'', case when b.show_results_after and public.app_question_settled(b, q.gate_open)');
      execute body;
    end if;
  end loop;
end $$;

do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'voter_state';

  if position('app_settled_results' in body) = 0 then
    -- and the waiting screen gains the finished ones
    body := replace(body,
      '    ''questions'', v_questions' || chr(10) || '  );',
      '    ''questions'', v_questions,' || chr(10) ||
      '    ''settled'', public.app_settled_results(b, a.voter_key)' || chr(10) || '  );');
    execute body;
  end if;
end $$;

-- --------------------------------------------------------------- the job
-- Daily, off the hour. The purge only ever takes what is already past its date,
-- so the exact minute does not matter -- but a round number is where everyone
-- else's cron jobs are.

create extension if not exists pg_cron;

select cron.unschedule('purge-expired-ballots')
 where exists (select 1 from cron.job where jobname = 'purge-expired-ballots');

select cron.schedule(
  'purge-expired-ballots',
  '17 3 * * *',
  $job$ select public.purge_expired_ballots(); $job$
);
