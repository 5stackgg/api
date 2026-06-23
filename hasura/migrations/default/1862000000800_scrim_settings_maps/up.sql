ALTER TABLE public.team_scrim_settings
  ADD COLUMN IF NOT EXISTS map_ids uuid[] NOT NULL DEFAULT '{}';
