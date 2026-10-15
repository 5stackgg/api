DROP TABLE IF EXISTS public.tournament_mvp_picks;

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS organizer_picks_mvp;
