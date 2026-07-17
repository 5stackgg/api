-- Winner-bracket advantage for the grand final of a double-elimination stage, expressed
-- in map points. The winner-bracket team (bracket.tournament_team_id_1 / lineup_1) starts
-- the grand-final match with this many map wins already banked. 0 disables the advantage.
ALTER TABLE public.tournament_stages
    ADD COLUMN final_map_advantage integer NOT NULL DEFAULT 0;
