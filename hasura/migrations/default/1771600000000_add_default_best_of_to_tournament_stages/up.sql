ALTER TABLE "public"."tournament_stages"
ADD COLUMN IF NOT EXISTS "default_best_of" integer NOT NULL DEFAULT 1;

ALTER TABLE "public"."tournament_stages"
ADD COLUMN IF NOT EXISTS "third_place_match" boolean NOT NULL DEFAULT false;

-- Temporarily disable triggers for backfill (avoids "tournament has been started" error
-- and prevents unnecessary bracket regeneration)
ALTER TABLE "public"."tournament_stages" DISABLE TRIGGER tbu_tournament_stages;
ALTER TABLE "public"."tournament_stages" DISABLE TRIGGER taiu_tournament_stages;

-- Backfill default_best_of from existing data: use stage match_options best_of, else tournament match_options best_of
UPDATE tournament_stages ts
SET default_best_of = COALESCE(
    (SELECT mo.best_of FROM match_options mo WHERE mo.id = ts.match_options_id),
    (SELECT mo.best_of FROM tournaments t JOIN match_options mo ON mo.id = t.match_options_id WHERE t.id = ts.tournament_id),
    1
);

-- Backfill: stages that had decider_best_of get third_place_match = true
UPDATE tournament_stages SET third_place_match = true WHERE decider_best_of IS NOT NULL;

-- Re-enable triggers
ALTER TABLE "public"."tournament_stages" ENABLE TRIGGER tbu_tournament_stages;
ALTER TABLE "public"."tournament_stages" ENABLE TRIGGER taiu_tournament_stages;
