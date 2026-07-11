-- Tags on event media must reference people actually involved in the event.
-- The Hasura insert permission only proves the *tagger* is the uploader or an
-- organizer; without this the FK would let them tag any player on the
-- platform. Lives in the triggers boot phase (not the migration) so
-- is_event_member (functions phase) exists before the first execution and so
-- digest tracking applies it to databases that already ran the migration.
CREATE OR REPLACE FUNCTION public.tg_event_media_players_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    _event public.events;
BEGIN
    SELECT e.* INTO _event
    FROM public.events e
    JOIN public.event_media m ON m.event_id = e.id
    WHERE m.id = NEW.media_id;

    IF _event.id IS NULL
       OR NOT public.is_event_member(_event, NEW.steam_id) THEN
        RAISE EXCEPTION 'tagged player must be involved in the event';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_event_media_players_member ON public.event_media_players;
CREATE TRIGGER tg_event_media_players_member
    BEFORE INSERT ON public.event_media_players
    FOR EACH ROW EXECUTE FUNCTION public.tg_event_media_players_member();
