-- Tournament trophies can now be awarded to either a player or a real team.
-- Team trophies are only created for tournament_teams rows that point at
-- public.teams via tournament_teams.team_id.

ALTER TABLE public.tournament_trophies
    ADD COLUMN team_id uuid REFERENCES public.teams(id) ON DELETE CASCADE;

ALTER TABLE public.tournament_trophies
    ALTER COLUMN player_steam_id DROP NOT NULL;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_id_tournament_team_id_player_key;

ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_team_player_placement_key;

DROP INDEX IF EXISTS public.tournament_trophies_tournament_team_player_placement_key;

ALTER TABLE public.tournament_trophies
    ADD CONSTRAINT tournament_trophies_one_recipient_check
    CHECK (
        (CASE WHEN player_steam_id IS NULL THEN 0 ELSE 1 END) +
        (CASE WHEN team_id IS NULL THEN 0 ELSE 1 END) = 1
    );

ALTER TABLE public.tournament_trophies
    ADD CONSTRAINT tournament_trophies_mvp_requires_player_check
    CHECK (placement <> 0 OR player_steam_id IS NOT NULL);

CREATE UNIQUE INDEX tournament_trophies_player_recipient_key
    ON public.tournament_trophies(tournament_id, tournament_team_id, player_steam_id, placement)
    WHERE player_steam_id IS NOT NULL;

CREATE UNIQUE INDEX tournament_trophies_team_recipient_key
    ON public.tournament_trophies(tournament_id, tournament_team_id, team_id, placement)
    WHERE team_id IS NOT NULL;

CREATE INDEX idx_tournament_trophies_team
    ON public.tournament_trophies(team_id, placement)
    WHERE team_id IS NOT NULL;
