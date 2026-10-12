-- Rows from before the column read as joined at this migration, the latest
-- they can have joined.
ALTER TABLE public.tournament_team_roster ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
