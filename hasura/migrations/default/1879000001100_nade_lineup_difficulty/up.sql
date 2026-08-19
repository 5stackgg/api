-- What everybody's practice says about a lineup, kept on the lineup so that
-- "is this a five-minute learn or a week's work" is one column read rather
-- than an aggregate over every progress row the lineup has ever collected.
--
-- practice_players counts progress rows that have at least one attempt, not
-- rows: a row is created the moment a lineup is opened, and a lineup nobody
-- has thrown at is not a lineup three people found hard.
ALTER TABLE "public"."nade_lineups"
    ADD COLUMN IF NOT EXISTS "practice_players" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "practice_attempts" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "practice_successes" integer NOT NULL DEFAULT 0;

-- Backfill from the progress rows that already exist. Triggers are off for
-- the duration because tbiu_nade_lineups re-validates the entire row on every
-- UPDATE -- a lineup on a map that has since been removed from public.maps
-- would abort the migration rather than be counted, and a backfill has no
-- business restamping updated_at either.
--
-- DISABLE TRIGGER USER rather than naming tbiu_nade_lineups: on a cold start
-- this migration runs before hasura/triggers is applied, so the trigger it
-- would name does not exist yet.
ALTER TABLE "public"."nade_lineups" DISABLE TRIGGER USER;

UPDATE "public"."nade_lineups" l
   SET "practice_players" = agg.players,
       "practice_attempts" = agg.attempts,
       "practice_successes" = agg.successes
  FROM (
         SELECT p.nade_lineup_id,
                count(*) FILTER (WHERE p.attempts > 0)::int AS players,
                COALESCE(sum(p.attempts), 0)::int AS attempts,
                COALESCE(sum(p.successes), 0)::int AS successes
           FROM public.nade_lineup_progress p
          GROUP BY p.nade_lineup_id
       ) agg
 WHERE agg.nade_lineup_id = l.id;

ALTER TABLE "public"."nade_lineups" ENABLE TRIGGER USER;
