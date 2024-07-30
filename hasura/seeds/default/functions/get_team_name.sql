CREATE OR REPLACE FUNCTION public.get_team_name(match_lineup public.match_lineups) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    team_name TEXT;
    lineup_1_id uuid;
BEGIN
    SELECT t.name, m.lineup_1_id INTO team_name, lineup_1_id
    FROM matches m
    INNER JOIN v_match_lineups ml ON ml.match_id = m.id
    LEFT JOIN teams t ON t.id = ml.team_id
    WHERE ml.id = match_lineup.id;
    -- If team ids match, return the team name
    IF team_name IS NOT NULL THEN
        RETURN team_name;
    END IF;
    -- If team ids do not match, look for captain's name or placeholder_name
    SELECT COALESCE(NULLIF(p.name, ''), mlp.placeholder_name) INTO team_name
    FROM match_lineup_players mlp
    LEFT JOIN players p ON p.steam_id = mlp.steam_id
    WHERE mlp.match_lineup_id = match_lineup.id AND mlp.captain = true
    LIMIT 1;
    -- If captain's name or placeholder_name is found, return it
    IF team_name IS NOT NULL THEN
        RETURN concat('Team ', team_name);
    END IF;
    -- If no captain, detect if it's a lineup 1 or 2 and display it as Team 1 or Team 2
    IF match_lineup.id = lineup_1_id THEN
        RETURN 'Team 1';
    ELSE
        RETURN 'Team 2';
    END IF;
END;
$$;