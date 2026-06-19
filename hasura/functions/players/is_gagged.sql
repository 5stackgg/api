CREATE OR REPLACE FUNCTION public.is_gagged(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM player_sanctions ps
        WHERE ps.player_steam_id = player.steam_id
        AND (ps.type = 'gag' OR ps.type = 'silence')
        AND ps.deleted_at IS NULL
        AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
    );
$$;
