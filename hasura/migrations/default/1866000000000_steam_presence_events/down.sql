ALTER TABLE "public"."steam_accounts" DROP COLUMN IF EXISTS "steam_level";
DROP INDEX IF EXISTS public.idx_steam_presence_events_created_at;
DROP TABLE IF EXISTS "public"."steam_presence_events";
