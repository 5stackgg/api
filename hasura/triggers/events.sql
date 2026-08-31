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
