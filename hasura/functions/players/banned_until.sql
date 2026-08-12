-- When a player's active ban(s) actually lift, so the UI can say "banned until
-- <date>" instead of a bare "you are banned" with no indication of when it ends.
--
-- NULL means either not banned at all, or banned with no end date. Callers check
-- is_banned() to tell those apart. A permanent ban deliberately wins over any
-- timed one that happens to be active at the same time -- returning the timed
-- date there would tell the player they are free at a point when they are not.
CREATE OR REPLACE FUNCTION public.banned_until(player public.players)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM player_sanctions ps
            WHERE ps.player_steam_id = player.steam_id
            AND ps.type = 'ban'
            AND ps.deleted_at IS NULL
            AND ps.remove_sanction_date IS NULL
        ) THEN NULL
        ELSE (
            SELECT MAX(ps.remove_sanction_date)
            FROM player_sanctions ps
            WHERE ps.player_steam_id = player.steam_id
            AND ps.type = 'ban'
            AND ps.deleted_at IS NULL
            AND ps.remove_sanction_date > now()
        )
    END;
$$;
