-- Revert to player-only tournament trophies.

DELETE FROM public.tournament_trophies
WHERE player_steam_id IS NULL;

DROP INDEX IF EXISTS public.idx_tournament_trophies_team;
DROP INDEX IF EXISTS public.tournament_trophies_team_recipient_key;
DROP INDEX IF EXISTS public.tournament_trophies_player_recipient_key;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_mvp_requires_player_check;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_one_recipient_check;

ALTER TABLE public.tournament_trophies
    ALTER COLUMN player_steam_id SET NOT NULL;

ALTER TABLE public.tournament_trophies
    DROP COLUMN team_id;

ALTER TABLE public.tournament_trophies
    ADD CONSTRAINT tournament_trophies_tournament_team_player_placement_key
    UNIQUE (tournament_id, tournament_team_id, player_steam_id, placement);
