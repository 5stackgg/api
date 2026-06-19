DROP INDEX IF EXISTS public.idx_player_sanctions_one_auto_ban;
DROP INDEX IF EXISTS public.idx_matches_created_at;
DROP INDEX IF EXISTS public.idx_match_lineup_players_steam_id;

DELETE FROM e_notification_types WHERE "value" = 'PlayerSanctioned';

DELETE FROM "public"."player_sanctions" WHERE "sanctioned_by_steam_id" IS NULL;

ALTER TABLE "public"."player_sanctions"
  DROP COLUMN IF EXISTS "deleted_at",
  ALTER COLUMN "sanctioned_by_steam_id" SET NOT NULL;

ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "steam_bans_checked_at",
  DROP COLUMN IF EXISTS "days_since_last_ban",
  DROP COLUMN IF EXISTS "game_ban_count",
  DROP COLUMN IF EXISTS "vac_ban_count",
  DROP COLUMN IF EXISTS "vac_banned";
