ALTER TABLE public.tournament_stages
    DROP CONSTRAINT IF EXISTS tournament_stages_final_map_advantage_check;
ALTER TABLE public.tournament_stages
    DROP COLUMN IF EXISTS final_map_advantage;

ALTER TABLE public.match_options
    DROP COLUMN IF EXISTS round_restart_delay,
    DROP COLUMN IF EXISTS halftime_pausematch;

ALTER TABLE public.tournament_organizers
    DROP COLUMN IF EXISTS organization_team_id;

DROP TABLE IF EXISTS public.tournament_organizer_teams;

ALTER TABLE public.teams
    DROP COLUMN IF EXISTS is_organization;

DROP TABLE IF EXISTS public.tournament_prizes;

DROP TABLE IF EXISTS public.tournament_categories;
DROP TABLE IF EXISTS public.e_tournament_categories;

ALTER TABLE public.tournaments
    DROP COLUMN IF EXISTS logo,
    DROP COLUMN IF EXISTS homepage,
    DROP COLUMN IF EXISTS location,
    DROP COLUMN IF EXISTS latitude,
    DROP COLUMN IF EXISTS longitude;
