ALTER TABLE public.tournament_organizers
    DROP COLUMN IF EXISTS organization_team_id;

DROP TABLE IF EXISTS public.tournament_organizer_teams;
