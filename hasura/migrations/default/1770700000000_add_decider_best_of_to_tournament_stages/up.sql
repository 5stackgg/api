ALTER TABLE "public"."tournament_stages"
ADD COLUMN IF NOT EXISTS "decider_best_of" integer NULL;
