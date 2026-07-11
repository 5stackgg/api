ALTER TABLE public.event_media
  DROP CONSTRAINT event_media_source_chk,
  ALTER COLUMN mime_type SET NOT NULL,
  ALTER COLUMN filename SET NOT NULL,
  DROP COLUMN external_url;
