-- The VAC cutoff moved from CS:GO's closed beta to CS2's limited test
-- (2023-03-22). A Steam check lifts an auto-ban the new cutoff no longer
-- covers, but only players in a recent match are re-checked on a schedule, so
-- this lifts the rest now. The ban date is taken from when Steam was asked.
UPDATE public.player_sanctions ps
   SET remove_sanction_date = now()
  FROM public.players p
 WHERE p.steam_id = ps.player_steam_id
   AND ps.type = 'ban'
   AND ps.sanctioned_by_steam_id IS NULL
   AND ps.deleted_at IS NULL
   AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
   AND p.vac_ban_count > 0
   AND p.steam_bans_checked_at IS NOT NULL
   AND p.steam_bans_checked_at - make_interval(days => COALESCE(p.days_since_last_ban, 0))
       < '2023-03-22'::timestamptz;
