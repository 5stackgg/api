CREATE OR REPLACE FUNCTION public.get_player_matches(player public.players) RETURNS SETOF public.matches
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    RETURN QUERY
        SELECT DISTINCT m.*
        FROM match_lineup_players mlp
        INNER JOIN matches m ON (m.lineup_1_id = mlp.match_lineup_id OR m.lineup_2_id = mlp.match_lineup_id)
        WHERE mlp.steam_id = player.steam_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_matches(player players)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(DISTINCT id)
    FROM (
        SELECT m.id
        FROM match_lineup_players mlp
        JOIN matches m
          ON m.lineup_1_id = mlp.match_lineup_id
        WHERE mlp.steam_id = player.steam_id

        UNION ALL

        SELECT m.id
        FROM match_lineup_players mlp
        JOIN matches m
          ON m.lineup_2_id = mlp.match_lineup_id
        WHERE mlp.steam_id = player.steam_id
    ) s;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_wins(player public.players) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_matches INT;
BEGIN
    SELECT COUNT(DISTINCT m.id)
    INTO total_matches
    FROM match_lineup_players mlp
    INNER JOIN matches m ON (m.lineup_1_id = mlp.match_lineup_id OR m.lineup_2_id = mlp.match_lineup_id)
    WHERE mlp.steam_id = player.steam_id
    and m.winning_lineup_id = mlp.match_lineup_id;

    RETURN total_matches;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses(player public.players) RETURNS INT
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_matches INT;
BEGIN
    SELECT COUNT(DISTINCT m.id)
    INTO total_matches
    FROM match_lineup_players mlp
    INNER JOIN matches m ON (m.lineup_1_id = mlp.match_lineup_id OR m.lineup_2_id = mlp.match_lineup_id)
    WHERE mlp.steam_id = player.steam_id
    and m.winning_lineup_id != mlp.match_lineup_id;

    RETURN total_matches;
END;
$$;