CREATE OR REPLACE FUNCTION public.get_player_matches(player public.players)
RETURNS SETOF public.matches
LANGUAGE SQL STABLE
AS $$
    SELECT DISTINCT m.*
    FROM match_lineup_players mlp
    JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    JOIN matches m ON m.id = ml.match_id
    WHERE mlp.steam_id = player.steam_id;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_matches(player players)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(DISTINCT ml.match_id)::int
    FROM match_lineup_players mlp
    JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    JOIN matches m ON m.id = ml.match_id
    WHERE mlp.steam_id = player.steam_id
      AND m.source = '5stack';
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
    INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE mlp.steam_id = player.steam_id
      AND m.winning_lineup_id = mlp.match_lineup_id
      AND m.source = '5stack';

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
    INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    INNER JOIN matches m ON m.id = ml.match_id
    WHERE mlp.steam_id = player.steam_id
      AND m.winning_lineup_id != mlp.match_lineup_id
      AND m.source = '5stack';

    RETURN total_matches;
END;
$$;
