-- The question cards show "N of M PINs voted", so the tally has to say what M
-- is. Disabled PINs are not counted -- nobody is waiting for them.
do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ballot_results';

  if position('eligible' in body) = 0 then
    body := replace(body,
      '''turnout'', jsonb_build_object(''issued'', v_tokens.issued, ''used'', v_tokens.used),',
      '''turnout'', jsonb_build_object(''issued'', v_tokens.issued, ''used'', v_tokens.used,'
        || ' ''eligible'', app.eligible_pins(p_ballot)),');
    execute body;
  end if;
end $$;
