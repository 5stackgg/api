-- Per-tournament trophy toggle. Lets organizers skip / clear trophies
-- on test or casual tournaments without affecting prior awards elsewhere.
ALTER TABLE public.tournaments
    ADD COLUMN trophies_enabled boolean NOT NULL DEFAULT true;

-- Drop the denormalized copies. Tournament metadata is read via the
-- existing `tournament` relation; visuals come from tournament_trophy_configs
-- through a new manual relationship on (tournament_id, placement).
ALTER TABLE public.tournament_trophies
    DROP COLUMN tournament_name,
    DROP COLUMN tournament_start,
    DROP COLUMN tournament_type,
    DROP COLUMN custom_name,
    DROP COLUMN silhouette,
    DROP COLUMN image_url;

-- Flag rows awarded outside the standard bracket calc (manual imports).
ALTER TABLE public.tournament_trophies
    ADD COLUMN manual boolean NOT NULL DEFAULT false;

-- Visuals are no longer copied onto tournament_trophies rows, so the
-- live-sync triggers on tournament_trophy_configs are dead weight.
DROP TRIGGER IF EXISTS tau_tournament_trophy_configs ON public.tournament_trophy_configs;
DROP TRIGGER IF EXISTS tad_tournament_trophy_configs ON public.tournament_trophy_configs;
DROP FUNCTION IF EXISTS public.tau_tournament_trophy_configs();
DROP FUNCTION IF EXISTS public.tad_tournament_trophy_configs();
