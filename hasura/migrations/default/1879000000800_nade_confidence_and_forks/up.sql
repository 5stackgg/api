-- confidence defaulted to 'exact', which is only true of a throw a server
-- watched. origin_source is not insertable by any non-admin role and defaults
-- to 'editor', so a lineup typed into the web editor arrived claiming to be an
-- engine-accurate recording while carrying hand-entered coordinates and no
-- physics seed. 'exact' is half of the plugin's IsExactlyReplayable() gate, so
-- the most trusting value in the enum was the one you got by saying nothing.
--
-- The default becomes the weakest claim; the trigger in
-- hasura/triggers/nade_lineups.sql is what makes it an invariant rather than a
-- convention, because every path that writes confidence explicitly (ingest,
-- mining, an admin insert, a fork) bypasses the default entirely.
ALTER TABLE "public"."nade_lineups"
    ALTER COLUMN "confidence" SET DEFAULT 'low';

-- Rows already written under the old default. 'derived' for a demo-mined row
-- and 'low' for everything else mirrors what the trigger will now enforce.
UPDATE "public"."nade_lineups"
   SET "confidence" = CASE
           WHEN "origin_source" = 'demo' THEN 'derived'
           ELSE 'low'
       END
 WHERE "confidence" = 'exact'
   AND "origin_source" NOT IN ('plugin', 'fork')
   AND (
       "initial_pos_x" IS NULL OR "initial_pos_y" IS NULL OR "initial_pos_z" IS NULL
       OR "initial_vel_x" IS NULL OR "initial_vel_y" IS NULL OR "initial_vel_z" IS NULL
   );

-- A fork is a copy of somebody else's lineup into your own library. It keeps
-- the geometry and drops the original's provenance, so this column IS the
-- fork's provenance: without it a forked row is indistinguishable from one
-- drawn by hand, and the original author's credit disappears silently.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the lineup you copied from
-- must not delete everyone's copies of it.
ALTER TABLE "public"."nade_lineups"
    ADD COLUMN IF NOT EXISTS "forked_from_nade_lineup_id" uuid;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'nade_lineups_forked_from_fkey'
    ) THEN
        ALTER TABLE "public"."nade_lineups"
            ADD CONSTRAINT "nade_lineups_forked_from_fkey"
            FOREIGN KEY ("forked_from_nade_lineup_id")
            REFERENCES "public"."nade_lineups" ("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS "nade_lineups_forked_from_idx"
    ON "public"."nade_lineups" ("forked_from_nade_lineup_id")
    WHERE "forked_from_nade_lineup_id" IS NOT NULL;
