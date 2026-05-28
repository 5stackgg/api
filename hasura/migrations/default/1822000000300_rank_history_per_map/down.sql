DROP INDEX IF EXISTS public.idx_player_rank_history_steam_type_map_observed;

ALTER TABLE "public"."player_premier_rank_history"
  DROP CONSTRAINT IF EXISTS "player_rank_history_map_id_fkey";
ALTER TABLE "public"."player_premier_rank_history"
  DROP COLUMN IF EXISTS "map_id";

ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "competitive_rank" integer,
  ADD COLUMN IF NOT EXISTS "competitive_rank_updated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "wingman_rank" integer,
  ADD COLUMN IF NOT EXISTS "wingman_rank_updated_at" timestamptz;
