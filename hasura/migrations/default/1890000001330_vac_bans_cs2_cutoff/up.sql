-- Steam's DaysSinceLastBan dates the newest ban of either kind, VAC or game,
-- so the newest VAC ban gets its own date. An account carrying both kinds
-- starts from the newest of either, which is no earlier than the VAC ban.
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS last_vac_ban_at timestamptz;

UPDATE public.players
   SET last_vac_ban_at = COALESCE(steam_bans_checked_at, now())
                         - make_interval(days => COALESCE(days_since_last_ban, 0))
 WHERE vac_ban_count > 0
   AND last_vac_ban_at IS NULL;

-- The VAC cutoff moved from CS:GO's closed beta to CS2's limited test
-- (2023-03-22). A Steam check lifts an auto-ban the new cutoff no longer
-- covers, but only players in a recent match are re-checked on a schedule, so
-- this lifts the rest now.
UPDATE public.player_sanctions ps
   SET remove_sanction_date = now()
  FROM public.players p
 WHERE p.steam_id = ps.player_steam_id
   AND ps.type = 'ban'
   AND ps.sanctioned_by_steam_id IS NULL
   AND ps.reason LIKE 'Auto: Steam%'
   AND ps.deleted_at IS NULL
   AND (ps.remove_sanction_date IS NULL OR ps.remove_sanction_date > now())
   AND p.vac_ban_count > 0
   AND p.last_vac_ban_at < '2023-03-22'::timestamptz;
