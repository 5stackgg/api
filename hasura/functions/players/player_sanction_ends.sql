-- Rewrites these players' ban_ends_at, gag_ends_at and mute_ends_at (all
-- players when NULL) from their sanctions that haven't been removed.
CREATE OR REPLACE FUNCTION public.refresh_player_sanction_ends(_steam_ids bigint[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF cardinality(_steam_ids) = 0 THEN
        RETURN;
    END IF;

    -- Locking the players first queues this behind another transaction still
    -- writing their sanctions, so the update below, a statement of its own,
    -- reads them once that one has committed. NO KEY, so it doesn't deadlock
    -- with the key-share lock each sanction insert holds on its player.
    PERFORM 1
    FROM public.players
    WHERE _steam_ids IS NULL OR steam_id = ANY (_steam_ids)
    ORDER BY steam_id
    FOR NO KEY UPDATE;

    UPDATE public.players p
    SET ban_ends_at = s.ban_ends_at,
        gag_ends_at = s.gag_ends_at,
        mute_ends_at = s.mute_ends_at
    FROM (
        SELECT ids.steam_id,
               COALESCE(MAX(COALESCE(ps.remove_sanction_date, 'infinity')) FILTER (WHERE ps.type = 'ban'), '-infinity') AS ban_ends_at,
               COALESCE(MAX(COALESCE(ps.remove_sanction_date, 'infinity')) FILTER (WHERE ps.type IN ('gag', 'silence')), '-infinity') AS gag_ends_at,
               COALESCE(MAX(COALESCE(ps.remove_sanction_date, 'infinity')) FILTER (WHERE ps.type IN ('mute', 'silence')), '-infinity') AS mute_ends_at
        FROM public.players ids
        LEFT JOIN public.player_sanctions ps
               ON ps.player_steam_id = ids.steam_id
              AND ps.deleted_at IS NULL
        WHERE _steam_ids IS NULL OR ids.steam_id = ANY (_steam_ids)
        GROUP BY ids.steam_id
    ) s
    WHERE p.steam_id = s.steam_id
      AND (p.ban_ends_at, p.gag_ends_at, p.mute_ends_at)
          IS DISTINCT FROM (s.ban_ends_at, s.gag_ends_at, s.mute_ends_at);
END;
$$;
