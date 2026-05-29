DROP INDEX IF EXISTS public.uq_matches_source_external_id;

ALTER TABLE "public"."matches"
  DROP COLUMN IF EXISTS "external_id";
