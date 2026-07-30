ALTER TABLE public.player_elo
  ADD COLUMN IF NOT EXISTS rating_for_expected double precision;
