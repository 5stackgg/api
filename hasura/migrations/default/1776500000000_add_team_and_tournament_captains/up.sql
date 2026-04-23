ALTER TABLE public.teams
    ADD COLUMN IF NOT EXISTS captain_steam_id bigint;

ALTER TABLE public.tournament_teams
    ADD COLUMN IF NOT EXISTS captain_steam_id bigint;

UPDATE public.teams
SET captain_steam_id = owner_steam_id
WHERE captain_steam_id IS NULL;

UPDATE public.tournament_teams
SET captain_steam_id = owner_steam_id
WHERE captain_steam_id IS NULL;

ALTER TABLE public.teams
    DROP CONSTRAINT IF EXISTS teams_captain_steam_id_fkey;

ALTER TABLE public.teams
    ADD CONSTRAINT teams_captain_steam_id_fkey
    FOREIGN KEY (captain_steam_id)
    REFERENCES public.players (steam_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL;

ALTER TABLE public.tournament_teams
    DROP CONSTRAINT IF EXISTS tournament_teams_captain_steam_id_fkey;

ALTER TABLE public.tournament_teams
    ADD CONSTRAINT tournament_teams_captain_steam_id_fkey
    FOREIGN KEY (captain_steam_id)
    REFERENCES public.players (steam_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL;
