-- Carries a tournament team's roster and captain into its lineup in every match
-- that exists but has not started. Underway, finished and canceled matches keep
-- the lineup they were played with.
CREATE OR REPLACE FUNCTION public.refresh_unstarted_tournament_team_lineups(_tournament_team_id uuid) RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    _tournament tournaments%ROWTYPE;
    _seatable int;
    _bracket tournament_brackets%ROWTYPE;
    _match matches%ROWTYPE;
BEGIN
    SELECT t.* INTO _tournament
    FROM tournament_teams tt
    INNER JOIN tournaments t ON t.id = tt.tournament_id
    WHERE tt.id = _tournament_team_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    SELECT count(*) INTO _seatable
    FROM tournament_team_roster ttr
    INNER JOIN players p ON p.steam_id = ttr.player_steam_id
    WHERE ttr.tournament_team_id = _tournament_team_id
      AND NOT is_banned(p);

    -- The match lineup guard refuses to shrink below the minimum, so a team
    -- that cannot field it keeps the seats it has instead of failing the write.
    IF _seatable < tournament_min_players_per_lineup(_tournament) THEN
        RETURN;
    END IF;

    FOR _bracket IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        INNER JOIN matches m ON m.id = tb.match_id
        WHERE ts.tournament_id = _tournament.id
          AND _tournament_team_id IN (tb.tournament_team_id_1, tb.tournament_team_id_2)
          AND m.status IN ('Scheduled', 'WaitingForCheckIn')
    LOOP
        SELECT * INTO _match
        FROM matches
        WHERE id = _bracket.match_id;

        PERFORM refresh_tournament_match_lineup(
            _match,
            CASE
                WHEN _bracket.tournament_team_id_1 = _tournament_team_id THEN _match.lineup_1_id
                ELSE _match.lineup_2_id
            END,
            _tournament_team_id
        );
    END LOOP;
END;
$$;
