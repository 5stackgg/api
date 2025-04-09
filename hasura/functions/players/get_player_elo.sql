CREATE OR REPLACE FUNCTION public.get_player_elo(player public.players) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    elo_value numeric;
BEGIN
    SELECT current INTO elo_value
    FROM player_elo
    WHERE steam_id = player.steam_id 
    ORDER BY created_at DESC 
    LIMIT 1;
    
    RETURN elo_value;
END;
$$;
