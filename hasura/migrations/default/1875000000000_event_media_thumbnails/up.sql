-- Poster frame for video media, captured client-side at upload time so
-- gallery tiles never fetch the mp4 itself.
ALTER TABLE public.event_media
    ADD COLUMN IF NOT EXISTS thumbnail_filename text;
