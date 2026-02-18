drop function if exists public.get_player_elo;
CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _active_season_id UUID;
BEGIN
    _active_season_id := get_active_season();

    return jsonb_build_object(
        'competitive', get_player_season_elo_by_type(player, 'Competitive', _active_season_id),
        'wingman', get_player_season_elo_by_type(player, 'Wingman', _active_season_id),
        'duel', get_player_season_elo_by_type(player, 'Duel', _active_season_id),
        'tournament_competitive', get_player_tournament_elo_by_type(player, 'Competitive'),
        'tournament_wingman', get_player_tournament_elo_by_type(player, 'Wingman'),
        'tournament_duel', get_player_tournament_elo_by_type(player, 'Duel')
    );
END;
$$;

drop function if exists public.get_player_elo_by_type;

CREATE OR REPLACE FUNCTION public.get_player_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
    AND "type" = _type
    ORDER BY created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;

-- Season ELO: latest ELO within a specific season
CREATE OR REPLACE FUNCTION public.get_player_season_elo_by_type(player public.players, _type text, _season_id UUID) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    IF _season_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id
    AND "type" = _type
    AND season_id = _season_id
    ORDER BY created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;

-- Tournament ELO: latest ELO from tournament matches (season_id IS NULL + joined with tournament_brackets)
CREATE OR REPLACE FUNCTION public.get_player_tournament_elo_by_type(player public.players, _type text) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT pe.current INTO elo_value
    FROM player_elo pe
    INNER JOIN tournament_brackets tb ON tb.match_id = pe.match_id
    WHERE pe.steam_id = player.steam_id
    AND pe."type" = _type
    AND pe.season_id IS NULL
    ORDER BY pe.created_at DESC
    LIMIT 1;

    RETURN elo_value;
END;
$$;
