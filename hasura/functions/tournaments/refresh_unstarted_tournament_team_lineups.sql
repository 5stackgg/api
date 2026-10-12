DROP FUNCTION IF EXISTS public.refresh_unstarted_tournament_team_lineups(uuid);

CREATE OR REPLACE FUNCTION public.refresh_unstarted_tournament_team_lineups(
    _tournament_team_id uuid,
    _follow_captain boolean
) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _tournament_id uuid;
    _status text;
    _match_id uuid;
    _match_lineup_id uuid;
    _match matches%ROWTYPE;
BEGIN
    SELECT tt.tournament_id, t.status
    INTO _tournament_id, _status
    FROM tournament_teams tt
    INNER JOIN tournaments t ON t.id = tt.tournament_id
    WHERE tt.id = _tournament_team_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    -- Matches drawn in Setup, RegistrationOpen or CheckInReview are rebuilt on
    -- the way out of them.
    IF _status NOT IN ('RegistrationClosed', 'Live', 'Paused') THEN
        RETURN;
    END IF;

    -- The team row before the matches: check_team_eligibility writes it after
    -- this refresh on a roster insert, and a status change locks team rows
    -- before it rebuilds matches.
    PERFORM 1
    FROM tournament_teams tt
    WHERE tt.id = _tournament_team_id
    FOR NO KEY UPDATE;

    -- FOR SHARE so a match moving past check-in either waits for this write or
    -- is re-read as started and skipped. The check-in status change also locks
    -- the match before its lineup rows (tau_matches clears checked_in).
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
        ORDER BY m.id
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
