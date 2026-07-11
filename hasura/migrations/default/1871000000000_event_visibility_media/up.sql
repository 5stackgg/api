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

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'Public'
        REFERENCES public.e_event_visibility(value);

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS media_access text NOT NULL DEFAULT 'Organizers'
        REFERENCES public.e_event_media_access(value);

CREATE TABLE IF NOT EXISTS public.event_media (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    uploader_steam_id bigint NOT NULL REFERENCES public.players(steam_id),
    filename text NOT NULL,
    mime_type text NOT NULL,
    size bigint NOT NULL DEFAULT 0,
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
