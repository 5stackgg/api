CREATE OR REPLACE FUNCTION public.check_tournament_finished(_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    total_brackets int;
    unfinished_brackets int;
    orphan tournament_brackets%ROWTYPE;
BEGIN
    -- Sweep any orphaned brackets (no teams, no pending feeders, bye=false,
    -- finished=false) and let resolve_bracket_bye mark them bye/finished.
    -- Without this, an orphaned bracket would be counted as "unfinished"
    -- below and the tournament would hang indefinitely.
    FOR orphan IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE ts.tournament_id = _tournament_id
          AND tb.finished = false
          AND tb.bye = false
          AND tb.tournament_team_id_1 IS NULL
          AND tb.tournament_team_id_2 IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM tournament_brackets child
              WHERE (child.parent_bracket_id = tb.id
                     OR child.loser_parent_bracket_id = tb.id)
                AND child.finished = false
          )
          AND EXISTS (
              SELECT 1 FROM tournament_brackets child
              WHERE child.parent_bracket_id = tb.id
                 OR child.loser_parent_bracket_id = tb.id
          )
        ORDER BY tb.round, tb.match_number
    LOOP
        PERFORM resolve_bracket_bye(orphan);
    END LOOP;

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