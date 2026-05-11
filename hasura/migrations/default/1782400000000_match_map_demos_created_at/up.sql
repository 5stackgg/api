ALTER TABLE public.match_map_demos
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.match_map_demos
SET created_at = metadata_parsed_at
WHERE metadata_parsed_at IS NOT NULL;
