ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "faceit_synced_at";

DROP TABLE IF EXISTS "public"."player_faceit_rank_history";
