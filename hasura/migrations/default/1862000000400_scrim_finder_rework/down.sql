ALTER TABLE public.team_scrim_settings
  DROP COLUMN IF EXISTS match_options_id,
  ADD COLUMN IF NOT EXISTS auto_accept boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prefer_ranked boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS map_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS best_of integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS mr integer NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS knife boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS overtime boolean NOT NULL DEFAULT true;

ALTER TABLE public.team_scrim_alerts
  ADD COLUMN IF NOT EXISTS map_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.team_scrim_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    other_team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    relation text NOT NULL CHECK (relation IN ('favorite', 'blocked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, other_team_id)
);

CREATE TABLE IF NOT EXISTS public.team_scrim_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    request_id uuid REFERENCES public.team_scrim_requests (id) ON UPDATE cascade ON DELETE SET NULL,
    match_id uuid REFERENCES public.matches (id) ON UPDATE cascade ON DELETE SET NULL,
    team_id uuid NOT NULL REFERENCES public.teams (id) ON UPDATE cascade ON DELETE cascade,
    result text NOT NULL CHECK (result IN ('completed', 'no_show', 'late_cancel', 'forfeit')),
    created_at timestamptz NOT NULL DEFAULT now()
);
