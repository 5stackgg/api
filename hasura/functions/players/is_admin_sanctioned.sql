-- Whether a player is banned by a real admin, as opposed to a ban issued
-- automatically by the system (which leaves sanctioned_by_steam_id null).
--
-- Same shape as is_banned() and safe to expose to the same roles: a plain
-- boolean, carrying none of the detail on player_sanctions (reason, who issued
-- it, dates) that a select permission on that table would leak.
CREATE OR REPLACE FUNCTION public.is_admin_sanctioned(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM player_sanctions ps
        WHERE ps.player_steam_id = player.steam_id
        AND ps.type = 'ban'
        AND ps.deleted_at IS NULL
        AND ps.sanctioned_by_steam_id IS NOT NULL
        AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
    );
$$;
