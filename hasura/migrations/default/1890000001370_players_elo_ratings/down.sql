DROP TABLE IF EXISTS public.player_elo_ratings_basis;
ALTER TABLE public.players DROP COLUMN IF EXISTS elo_ratings;
