drop function if exists public.get_player_elo;
CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    return jsonb_build_object(
        'competitive', get_player_elo_by_type(player, 'Competitive'),
        'wingman', get_player_elo_by_type(player, 'Wingman'),
        'duel', get_player_elo_by_type(player, 'Duel')
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