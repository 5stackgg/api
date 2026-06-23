-- Bring existing databases up to the match_options-reuse scrim schema.
-- Idempotent: a no-op on fresh installs where 1861000000100 already built
-- the table in its final shape.

ALTER TABLE public.team_scrim_settings
  ADD COLUMN IF NOT EXISTS match_options_id uuid
    REFERENCES public.match_options (id) ON UPDATE cascade ON DELETE SET NULL;

ALTER TABLE public.team_scrim_settings
  DROP COLUMN IF EXISTS auto_accept,
  DROP COLUMN IF EXISTS prefer_ranked,
  DROP COLUMN IF EXISTS map_ids,
  DROP COLUMN IF EXISTS best_of,
  DROP COLUMN IF EXISTS mr,
  DROP COLUMN IF EXISTS knife,
  DROP COLUMN IF EXISTS overtime;

ALTER TABLE public.team_scrim_alerts
  DROP COLUMN IF EXISTS map_ids;

-- The old v_team_reputation view depends on team_scrim_outcomes; drop it so the
-- table can be removed. It is recreated from match data in the next migration.
DROP VIEW IF EXISTS public.v_team_reputation;

DROP TABLE IF EXISTS public.team_scrim_outcomes;
DROP TABLE IF EXISTS public.team_scrim_relations;
