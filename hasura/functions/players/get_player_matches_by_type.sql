CREATE OR REPLACE FUNCTION public.get_total_player_wins_by_type(player public.players, _match_type TEXT) RETURNS INT
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
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE mlp.steam_id = player.steam_id
    AND m.winning_lineup_id = mlp.match_lineup_id
    AND mo."type" = _match_type;

    RETURN total_matches;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses_by_type(player public.players, _match_type TEXT) RETURNS INT
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
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE mlp.steam_id = player.steam_id
    AND m.winning_lineup_id != mlp.match_lineup_id
    AND mo."type" = _match_type;

    RETURN total_matches;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_total_player_wins_competitive(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_wins_by_type(player, 'Competitive'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_wins_wingman(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_wins_by_type(player, 'Wingman'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_wins_duel(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_wins_by_type(player, 'Duel'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses_competitive(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_losses_by_type(player, 'Competitive'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses_wingman(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_losses_by_type(player, 'Wingman'); $$;

CREATE OR REPLACE FUNCTION public.get_total_player_losses_duel(player public.players) RETURNS INT
    LANGUAGE sql STABLE
    AS $$ SELECT public.get_total_player_losses_by_type(player, 'Duel'); $$;
