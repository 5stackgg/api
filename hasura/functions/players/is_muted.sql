CREATE OR REPLACE FUNCTION public.is_muted(player public.players)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM player_sanctions ps
        WHERE ps.player_steam_id = player.steam_id
        AND (ps.type = 'mute' OR ps.type = 'silence')
        AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
    );
END;
$$
