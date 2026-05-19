ALTER TABLE public.player_positions
  ADD COLUMN IF NOT EXISTS health smallint;
