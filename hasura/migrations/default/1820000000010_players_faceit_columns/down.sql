ALTER TABLE "public"."players"
  DROP COLUMN IF EXISTS "faceit_player_id",
  DROP COLUMN IF EXISTS "faceit_nickname",
  DROP COLUMN IF EXISTS "faceit_skill_level",
  DROP COLUMN IF EXISTS "faceit_elo",
  DROP COLUMN IF EXISTS "faceit_url",
  DROP COLUMN IF EXISTS "faceit_updated_at";
