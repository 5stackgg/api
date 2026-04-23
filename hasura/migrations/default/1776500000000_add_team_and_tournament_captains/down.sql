ALTER TABLE public.tournament_teams
    DROP CONSTRAINT IF EXISTS tournament_teams_captain_steam_id_fkey;

ALTER TABLE public.teams
    DROP CONSTRAINT IF EXISTS teams_captain_steam_id_fkey;

ALTER TABLE public.tournament_teams
    DROP COLUMN IF EXISTS captain_steam_id;

ALTER TABLE public.teams
    DROP COLUMN IF EXISTS captain_steam_id;
