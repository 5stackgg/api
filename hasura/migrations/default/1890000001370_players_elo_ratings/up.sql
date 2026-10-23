-- players.elo is read for every player in every roster, lineup and list on
-- every poll, but only changes when a rating is written or voided, when seasons
-- are switched on or off, or when the active season changes. So it is kept here
-- (hasura/functions/players/player_elo_ratings.sql) and read as a column.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS elo_ratings jsonb;

-- Whether seasons were on, and which season was active, when the stored values
-- were built; a difference means they all need rebuilding.
CREATE TABLE IF NOT EXISTS public.player_elo_ratings_basis (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    seasons boolean NOT NULL,
    season_id uuid
);
