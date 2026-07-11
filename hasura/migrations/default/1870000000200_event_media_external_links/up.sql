ALTER TABLE public.event_media
  ADD COLUMN external_url text,
  ALTER COLUMN filename DROP NOT NULL,
  ALTER COLUMN mime_type DROP NOT NULL,
  ADD CONSTRAINT event_media_source_chk
    CHECK (num_nonnulls(filename, external_url) = 1);
