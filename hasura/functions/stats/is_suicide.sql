CREATE OR REPLACE FUNCTION public.is_suicide(player_kill public.player_kills)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT player_kill.attacker_steam_id = player_kill.attacked_steam_id;
$$;
