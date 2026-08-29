DROP TABLE IF EXISTS public.tournament_registration_unlocks;

ALTER TABLE public.tournament_teams
    DROP COLUMN IF EXISTS is_drafted;
