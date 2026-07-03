-- Events: curated mini-season containers grouping selected tournaments.
-- Design: docs/plans/2026-07-03-events-feature-design.md (polyrepo root).

CREATE TABLE IF NOT EXISTS public.e_event_status (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_event_status (value, description) VALUES
    ('Setup', 'Event is being set up; hidden from the public'),
    ('Live', 'Event is in progress'),
    ('Finished', 'Event has finished')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.events (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    starts_at timestamptz,
    ends_at timestamptz,
    status text NOT NULL DEFAULT 'Setup' REFERENCES public.e_event_status(value),
    organizer_steam_id bigint NOT NULL REFERENCES public.players(steam_id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_organizers (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.event_tournaments (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, tournament_id)
);
CREATE INDEX IF NOT EXISTS idx_event_tournaments_tournament
    ON public.event_tournaments(tournament_id);

CREATE TABLE IF NOT EXISTS public.event_teams (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_event_teams_team ON public.event_teams(team_id);

CREATE TABLE IF NOT EXISTS public.event_players (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_event_players_steam ON public.event_players(steam_id);
