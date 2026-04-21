ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT IF EXISTS tournament_trophies_tournament_team_player_placement_key;

ALTER TABLE public.tournament_trophies
    ADD CONSTRAINT tournament_trophies_tournament_id_tournament_team_id_player_key
    UNIQUE (tournament_id, tournament_team_id, player_steam_id);
