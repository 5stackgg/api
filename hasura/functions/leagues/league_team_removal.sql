-- Admin removal of a team from a running season (team died mid-season):
-- withdraws the registration and forfeits every remaining regular-season
-- matchup to the opponent. Movements later mark the team as 'Remove'.
CREATE OR REPLACE FUNCTION public.remove_league_team_from_season(
    _league_team_season_id uuid,
    hasura_session json
)
RETURNS SETOF public.league_team_seasons
LANGUAGE plpgsql
AS $$
DECLARE
    registration public.league_team_seasons;
    _bracket RECORD;
    _opponent uuid;
BEGIN
    SELECT * INTO registration
    FROM public.league_team_seasons
    WHERE id = _league_team_season_id;

    IF registration IS NULL THEN
        RAISE EXCEPTION 'Registration not found' USING ERRCODE = '22000';
    END IF;

    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    UPDATE public.league_team_seasons
    SET status = 'Withdrawn'
    WHERE id = _league_team_season_id
      AND status != 'Withdrawn';

    IF registration.tournament_team_id IS NOT NULL THEN
        FOR _bracket IN
            SELECT tb.*
            FROM public.tournament_brackets tb
            WHERE tb.finished = false
              AND (tb.tournament_team_id_1 = registration.tournament_team_id
                OR tb.tournament_team_id_2 = registration.tournament_team_id)
              AND tb.tournament_team_id_1 IS NOT NULL
              AND tb.tournament_team_id_2 IS NOT NULL
            ORDER BY tb.round, tb.match_number
        LOOP
            _opponent := CASE
                WHEN _bracket.tournament_team_id_1 = registration.tournament_team_id
                THEN _bracket.tournament_team_id_2
                ELSE _bracket.tournament_team_id_1
            END;
            PERFORM public.league_award_forfeit(_bracket.id, _opponent, hasura_session);
        END LOOP;
    END IF;

    RETURN QUERY
    SELECT * FROM public.league_team_seasons WHERE id = _league_team_season_id;
END;
$$;
