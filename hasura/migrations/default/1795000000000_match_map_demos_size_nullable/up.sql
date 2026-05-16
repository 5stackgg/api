ALTER TABLE public.match_map_demos
  ALTER COLUMN size DROP NOT NULL;

ALTER TABLE public.match_map_demos
  ADD CONSTRAINT match_map_demos_match_map_id_file_key
  UNIQUE (match_map_id, file);
