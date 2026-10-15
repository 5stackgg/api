ALTER TABLE public.chat_room_settings
    ADD COLUMN IF NOT EXISTS mute_minutes integer;

ALTER TABLE public.chat_room_settings
    DROP CONSTRAINT IF EXISTS chat_room_settings_mute_minutes;

ALTER TABLE public.chat_room_settings
    ADD CONSTRAINT chat_room_settings_mute_minutes
    CHECK (mute_minutes BETWEEN 1 AND 1440);
