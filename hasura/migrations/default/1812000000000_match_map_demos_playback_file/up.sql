ALTER TABLE public.match_map_demos
  ADD COLUMN IF NOT EXISTS playback_file text;
