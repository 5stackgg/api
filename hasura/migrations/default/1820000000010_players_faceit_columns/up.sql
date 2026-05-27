ALTER TABLE "public"."players"
  ADD COLUMN IF NOT EXISTS "faceit_player_id" text,
  ADD COLUMN IF NOT EXISTS "faceit_nickname" text,
  ADD COLUMN IF NOT EXISTS "faceit_skill_level" integer,
  ADD COLUMN IF NOT EXISTS "faceit_elo" integer,
  ADD COLUMN IF NOT EXISTS "faceit_url" text,
  ADD COLUMN IF NOT EXISTS "faceit_updated_at" timestamptz;
