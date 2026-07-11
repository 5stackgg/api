-- Events: curated mini-season containers grouping selected tournaments.
-- Design: docs/plans/2026-07-03-events-feature-design.md (polyrepo root).

CREATE TABLE IF NOT EXISTS public.e_event_visibility (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_event_visibility (value, description) VALUES
    ('Private', 'Only people involved in the event'),
    ('Friends', 'Involved people and their friends'),
    ('Public', 'Anyone')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.e_event_media_access (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_event_media_access (value, description) VALUES
    ('Organizers', 'Organizers only'),
    ('Involved', 'Anyone involved in the event')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.events (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    starts_at timestamptz,
    ends_at timestamptz,
    visibility text NOT NULL DEFAULT 'Public'
        REFERENCES public.e_event_visibility(value),
    media_access text NOT NULL DEFAULT 'Organizers'
        REFERENCES public.e_event_media_access(value),
    -- The creator is shown in "Organized by" by default but can be hidden
    -- from that display (they remain the owner for permissions).
    hide_creator_organizer boolean NOT NULL DEFAULT false,
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

CREATE TABLE IF NOT EXISTS public.event_media (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    uploader_steam_id bigint NOT NULL REFERENCES public.players(steam_id),
    filename text NOT NULL,
    mime_type text NOT NULL,
    size bigint NOT NULL DEFAULT 0,
    title text,
    -- Poster frame for video media, captured client-side at upload time so
    -- gallery tiles never fetch the mp4 itself.
    thumbnail_filename text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_event_media_event ON public.event_media(event_id);

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS banner_media_id uuid
        REFERENCES public.event_media(id) ON DELETE SET NULL;

-- A single-column FK cannot enforce that the banner belongs to this event.
CREATE OR REPLACE FUNCTION public.tg_events_banner_same_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.banner_media_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_media m
    WHERE m.id = NEW.banner_media_id AND m.event_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'banner_media_id must reference media of the same event';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_events_banner_same_event ON public.events;
CREATE TRIGGER tg_events_banner_same_event
  BEFORE INSERT OR UPDATE OF banner_media_id ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.tg_events_banner_same_event();

-- Media items can tag the players featured in them.
CREATE TABLE IF NOT EXISTS public.event_media_players (
    media_id uuid NOT NULL REFERENCES public.event_media(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (media_id, steam_id)
);
CREATE INDEX IF NOT EXISTS idx_event_media_players_steam
    ON public.event_media_players(steam_id);

-- Materialized event->match links. v_event_matches stays the single source
-- of truth for the derivation; triggers (hasura/triggers/event_match_links)
-- keep this table in sync so list queries paginate over an indexed table and
-- stats aggregate without re-deriving the windowed joins per query.
CREATE TABLE IF NOT EXISTS public.event_match_links (
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_event_match_links_match
    ON public.event_match_links(match_id);
