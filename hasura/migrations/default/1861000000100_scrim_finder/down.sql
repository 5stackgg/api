DELETE FROM public.settings WHERE name = 'scrim_team_autodetect_min_overlap';

DROP VIEW IF EXISTS public.v_team_reputation;

DROP TABLE IF EXISTS public.team_suggestions;
DROP TABLE IF EXISTS public.team_scrim_alerts;
DROP TABLE IF EXISTS public.team_scrim_request_proposals;
DROP TABLE IF EXISTS public.team_scrim_requests;
DROP TABLE IF EXISTS public.team_scrim_availability;
DROP TABLE IF EXISTS public.team_scrim_settings;
DROP TABLE IF EXISTS public.e_scrim_request_statuses;

ALTER TABLE "public"."match_options"
  DROP COLUMN IF EXISTS "ranked";
