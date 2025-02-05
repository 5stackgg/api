CREATE OR REPLACE FUNCTION public.get_player_matches(player public.players) RETURNS SETOF public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
        SELECT m.*
        FROM players p
        INNER JOIN match_lineup_players mlp ON mlp.steam_id = p.steam_id
        INNER JOIN matches m ON m.lineup_1_id = mlp.match_lineup_id or m.lineup_2_id = mlp.match_lineup_id
        WHERE p.steam_id = player.steam_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_matches(player public.players) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_matches INT;
BEGIN
    SELECT count(*)
    INTO total_matches
    FROM players p
    INNER JOIN match_lineup_players mlp ON mlp.steam_id = p.steam_id
    INNER JOIN matches m ON m.lineup_1_id = mlp.match_lineup_id or m.lineup_2_id = mlp.match_lineup_id
    WHERE p.steam_id = player.steam_id;

    RETURN total_matches;
END;
$$;