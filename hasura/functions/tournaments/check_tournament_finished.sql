CREATE OR REPLACE FUNCTION public.check_tournament_finished(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    total_brackets int;
    unfinished_brackets int;
BEGIN
    -- Note: RoundRobin stage advancement is handled in update_tournament_bracket
    -- when individual matches finish, so we don't need to handle it here

    select count(*) into total_brackets
    from tournament_brackets tb
    inner join tournament_stages ts on ts.id = tb.tournament_stage_id
    where ts.tournament_id = _tournament_id
    and tb.bye = false;

   select count(*) into unfinished_brackets
    from tournament_brackets tb
    inner join tournament_stages ts on ts.id = tb.tournament_stage_id
    where ts.tournament_id = _tournament_id
    and tb.bye = false
    and tb.finished = false;

    if unfinished_brackets = 0 then
        update tournaments
        set status = 'Finished'
        where id = _tournament_id;
    end if;
END;
$$;