CREATE TABLE IF NOT EXISTS "public"."gamedata_signature_validations" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "build_id" integer NOT NULL,
    "branch" text NOT NULL DEFAULT 'public',
    "status" text NOT NULL,
    "results" jsonb,
    "validated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);

DO $$
BEGIN
   IF NOT EXISTS (
       SELECT 1
       FROM information_schema.table_constraints
       WHERE constraint_name = 'gamedata_signature_validations_build_id_fkey'
         AND table_name = 'gamedata_signature_validations'
   ) THEN
       ALTER TABLE "public"."gamedata_signature_validations"
       ADD CONSTRAINT "gamedata_signature_validations_build_id_fkey"
       FOREIGN KEY ("build_id")
       REFERENCES "public"."game_versions" ("build_id")
       ON UPDATE CASCADE
       ON DELETE CASCADE;
   END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "gamedata_signature_validations_build_branch_idx"
    ON "public"."gamedata_signature_validations" ("build_id", "branch");
