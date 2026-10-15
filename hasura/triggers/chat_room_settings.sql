-- A mute's end is worked out here, from the length the player asked for and
-- the database's clock, the same clock the push gate compares it with. A
-- device's clock would move it. Only a write to the mute itself sets it again,
-- so a change of level leaves a running mute's end where it was.
CREATE OR REPLACE FUNCTION public.tbiu_chat_room_settings() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT NEW.muted THEN
        NEW.mute_minutes := NULL;
    END IF;

    NEW.muted_until := CASE
        WHEN NEW.mute_minutes IS NULL THEN NULL
        ELSE now() + make_interval(mins => NEW.mute_minutes)
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_chat_room_settings ON public.chat_room_settings;
CREATE TRIGGER tbiu_chat_room_settings
    BEFORE INSERT OR UPDATE OF muted, mute_minutes ON public.chat_room_settings
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_chat_room_settings();
