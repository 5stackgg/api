CREATE OR REPLACE FUNCTION public.is_suicide(player_kill public.player_kills)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN player_kill.attacker_steam_id = player_kill.attacked_steam_id;
END
$$;
