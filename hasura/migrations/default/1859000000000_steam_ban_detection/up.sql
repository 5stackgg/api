ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "vac_banned" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "vac_ban_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "game_ban_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "days_since_last_ban" integer,
  ADD COLUMN IF NOT EXISTS "steam_bans_checked_at" timestamptz;

ALTER TABLE "public"."player_sanctions"
  ALTER COLUMN "sanctioned_by_steam_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

INSERT INTO e_notification_types ("value", "description") VALUES
    ('PlayerSanctioned', 'A player you recently played with received a sanction')
ON CONFLICT("value") DO UPDATE SET "description" = EXCLUDED."description";

CREATE INDEX IF NOT EXISTS idx_match_lineup_players_steam_id
  ON public.match_lineup_players (steam_id);

CREATE INDEX IF NOT EXISTS idx_matches_created_at
  ON public.matches (created_at);

DELETE FROM public.player_sanctions ps
 WHERE ps.type = 'ban'
   AND ps.sanctioned_by_steam_id IS NULL
   AND ps.id NOT IN (
     SELECT DISTINCT ON (player_steam_id) id
       FROM public.player_sanctions
      WHERE type = 'ban'
        AND sanctioned_by_steam_id IS NULL
      ORDER BY player_steam_id, created_at DESC
   );

-- NOTE: player_sanctions is a TimescaleDB hypertable partitioned by created_at,
-- so a UNIQUE index cannot be created without including the partition column.
-- Uniqueness of auto-bans is enforced in application code (SteamBansService),
-- the DELETE above dedupes existing rows, and this partial index keeps lookups fast.
CREATE INDEX IF NOT EXISTS idx_player_sanctions_one_auto_ban
  ON public.player_sanctions (player_steam_id)
  WHERE type = 'ban' AND sanctioned_by_steam_id IS NULL;
