alter table "public"."match_options" add column if not exists "pause_setting" text
 not null default 'CoachAndPlayers';

DO $$
BEGIN
   IF NOT EXISTS (
       SELECT 1
       FROM information_schema.table_constraints
       WHERE constraint_name = 'match_options_pause_setting_fkey'
         AND table_name = 'match_options'
   ) THEN
      ALTER TABLE "public"."match_options"
      ADD CONSTRAINT "match_options_pause_setting_fkey"
      FOREIGN KEY ("pause_setting")
      REFERENCES "public"."e_timeout_settings" ("value")
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
   END IF;
END $$;
