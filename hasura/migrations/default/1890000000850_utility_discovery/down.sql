DROP TABLE IF EXISTS "public"."utility_discovery_results";
DROP TABLE IF EXISTS "public"."utility_discoveries";
ALTER TABLE public.utility_practice_sessions DROP COLUMN IF EXISTS is_discovery;
