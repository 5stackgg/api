ALTER TABLE "public"."match_map_demos"
  DROP CONSTRAINT IF EXISTS "match_demos_match_id_fkey";

ALTER TABLE "public"."match_map_demos"
  ADD CONSTRAINT "match_demos_match_id_fkey"
  FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id")
  ON UPDATE CASCADE ON DELETE RESTRICT;

DROP TABLE IF EXISTS "public"."player_premier_rank_history";
DROP TABLE IF EXISTS "public"."pending_match_import_players";
DROP TABLE IF EXISTS "public"."pending_match_imports";

DROP INDEX IF EXISTS public.idx_players_last_sign_in_at;
DROP INDEX IF EXISTS public.idx_match_map_demos_file;
DROP INDEX IF EXISTS public.idx_matches_external_created_at;
DROP INDEX IF EXISTS public.idx_matches_5stack_ended_at;

ALTER TABLE "public"."matches" DROP COLUMN IF EXISTS "source";
DELETE FROM public.e_match_types WHERE value = 'Premier';

DROP TABLE IF EXISTS "public"."player_steam_match_auth";

ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "premier_rank_updated_at",
  DROP COLUMN IF EXISTS "premier_rank";
