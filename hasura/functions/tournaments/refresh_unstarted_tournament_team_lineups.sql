CREATE OR REPLACE FUNCTION public.refresh_unstarted_tournament_team_lineups(
    _tournament_team_id uuid,
    _follow_captain boolean
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _tournament_id uuid;
    _match_id uuid;
    _match_lineup_id uuid;
    _match matches%ROWTYPE;
BEGIN
    SELECT tt.tournament_id
    INTO _tournament_id
    FROM tournament_teams tt
    WHERE tt.id = _tournament_team_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- FOR SHARE so a match moving past check-in either waits for this write or
    -- is re-read as started and skipped. Lock order is match then lineup rows,
    -- the same order the check-in status change takes (tau_matches clears
    -- checked_in after the match row is locked).
    FOR _match_id, _match_lineup_id IN
        SELECT m.id,
               CASE
                   WHEN tb.tournament_team_id_1 = _tournament_team_id THEN m.lineup_1_id
                   ELSE m.lineup_2_id
               END
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = _tournament_id
          AND _tournament_team_id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
          AND m.status IN ('Scheduled', 'WaitingForCheckIn')
        FOR SHARE OF m
    LOOP
        SELECT * INTO _match
        FROM matches
        WHERE id = _match_id;

        PERFORM refresh_tournament_match_lineup(
            _match,
            _match_lineup_id,
            _tournament_team_id,
            _follow_captain
        );
    END LOOP;
END;
$$;
