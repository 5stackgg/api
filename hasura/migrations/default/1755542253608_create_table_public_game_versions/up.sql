CREATE TABLE IF NOT EXISTS "public"."game_versions" (
  "build_id" text NOT NULL,
  "version" text NOT NULL,
  "description" text NOT NULL,
  "current" boolean,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("build_id")
);

-- Ensure only one row can have current = true
CREATE UNIQUE INDEX IF NOT EXISTS one_current_true_idx
  ON "public"."game_versions" (current)
  WHERE current IS TRUE;
