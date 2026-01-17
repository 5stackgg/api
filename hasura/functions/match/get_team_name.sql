CREATE OR REPLACE FUNCTION public.get_team_name(
    match_lineup public.match_lineups
)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _team_name TEXT;
    _lineup_1_id uuid;
    _lineup_2_id uuid;
BEGIN
    SELECT
        m.lineup_1_id,
        m.lineup_2_id,
        COALESCE(ml.team_name, t.name)
    INTO
        _lineup_1_id,
        _lineup_2_id,
        _team_name
    FROM matches m
    JOIN v_match_lineups ml ON ml.match_id = m.id
    LEFT JOIN teams t ON t.id = ml.team_id
    WHERE ml.id = match_lineup.id;

    IF _team_name IS NOT NULL THEN
        RETURN _team_name;
    END IF;

    SELECT tt.name
    INTO _team_name
    FROM matches m
    JOIN tournament_brackets tb ON tb.match_id = m.id
    JOIN tournament_teams tt ON
        (
            match_lineup.id = m.lineup_1_id
            AND tt.id = tb.tournament_team_id_1
        )
        OR
        (
            match_lineup.id = m.lineup_2_id
            AND tt.id = tb.tournament_team_id_2
        )
    WHERE m.id = (
        SELECT match_id
        FROM match_lineups
        WHERE id = match_lineup.id
    )
    LIMIT 1;

    IF _team_name IS NOT NULL THEN
        RETURN _team_name;
    END IF;

    SELECT COALESCE(NULLIF(p.name, ''), mlp.placeholder_name)
    INTO _team_name
    FROM match_lineup_players mlp
    LEFT JOIN players p ON p.steam_id = mlp.steam_id
    WHERE mlp.match_lineup_id = match_lineup.id
      AND mlp.captain = true
    LIMIT 1;

    IF _team_name IS NOT NULL THEN
        RETURN _team_name || '''s Team';
    END IF;

    IF match_lineup.id = _lineup_1_id THEN
        RETURN 'Team 1';
    ELSE
        RETURN 'Team 2';
    END IF;
END;
$$;
