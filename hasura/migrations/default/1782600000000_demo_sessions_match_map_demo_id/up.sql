ALTER TABLE public.match_demo_sessions
  ADD COLUMN match_map_demo_id uuid;

UPDATE public.match_demo_sessions s
SET match_map_demo_id = (
  SELECT d.id
  FROM public.match_map_demos d
  WHERE d.match_map_id = s.match_map_id
  ORDER BY d.metadata_parsed_at DESC NULLS LAST, d.id DESC
  LIMIT 1
)
WHERE match_map_demo_id IS NULL;

ALTER TABLE public.match_demo_sessions
  ADD CONSTRAINT match_demo_sessions_match_map_demo_id_fkey
    FOREIGN KEY (match_map_demo_id)
    REFERENCES public.match_map_demos (id)
    ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX match_demo_sessions_match_map_demo_id_idx
  ON public.match_demo_sessions (match_map_demo_id);
