ALTER TABLE public.match_map_demos
  DROP CONSTRAINT IF EXISTS match_map_demos_match_map_id_file_key;

ALTER TABLE public.match_map_demos
  ALTER COLUMN size SET NOT NULL;
