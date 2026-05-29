ALTER TABLE "public"."matches"
  ADD COLUMN IF NOT EXISTS "external_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_matches_source_external_id
  ON public.matches (source, external_id)
  WHERE external_id IS NOT NULL;
