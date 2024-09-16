CREATE TABLE IF NOT EXISTS "public"."abandoned_matches" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "steam_id" bigint NOT NULL,
    "abandoned_at" timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("id")
);

DO $$
BEGIN
   IF NOT EXISTS (
       SELECT 1
       FROM information_schema.table_constraints
       WHERE constraint_name = 'abandoned_matches_steam_id_fkey'
         AND table_name = 'abandoned_matches'
   ) THEN
       ALTER TABLE "public"."abandoned_matches"
       ADD CONSTRAINT "abandoned_matches_steam_id_fkey"
       FOREIGN KEY ("steam_id")
       REFERENCES "public"."players" ("steam_id")
       ON UPDATE CASCADE
       ON DELETE CASCADE;
   END IF;
END $$;
