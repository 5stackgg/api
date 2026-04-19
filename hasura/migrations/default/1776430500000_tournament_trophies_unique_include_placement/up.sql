-- Allow a player to hold both a placement trophy (gold/silver/bronze) and MVP
-- on the same tournament. The old uniqueness key blocked the second insert
-- when the MVP was on the winning team.
ALTER TABLE public.tournament_trophies
    DROP CONSTRAINT tournament_trophies_tournament_id_tournament_team_id_player_key;

ALTER TABLE public.tournament_trophies
    ADD CONSTRAINT tournament_trophies_tournament_team_player_placement_key
    UNIQUE (tournament_id, tournament_team_id, player_steam_id, placement);
