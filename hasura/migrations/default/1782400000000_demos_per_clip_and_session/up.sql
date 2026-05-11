ALTER TABLE public.match_map_demos
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

UPDATE public.match_map_demos
SET created_at = metadata_parsed_at
WHERE metadata_parsed_at IS NOT NULL;

ALTER TABLE public.clip_render_jobs
  ADD COLUMN match_map_demo_id uuid;

ALTER TABLE public.match_clips
  ADD COLUMN match_map_demo_id uuid;

ALTER TABLE public.match_demo_sessions
  ADD COLUMN match_map_demo_id uuid;

UPDATE public.clip_render_jobs j
SET match_map_demo_id = (
  SELECT d.id
  FROM public.match_map_demos d
  WHERE d.match_map_id = j.match_map_id
  ORDER BY d.metadata_parsed_at DESC NULLS LAST, d.id DESC
  LIMIT 1
)
WHERE j.match_map_demo_id IS NULL;

UPDATE public.match_clips c
SET match_map_demo_id = (
  SELECT d.id
  FROM public.match_map_demos d
  WHERE d.match_map_id = c.match_map_id
  ORDER BY d.metadata_parsed_at DESC NULLS LAST, d.id DESC
  LIMIT 1
)
WHERE c.match_map_demo_id IS NULL;

UPDATE public.match_demo_sessions s
SET match_map_demo_id = (
  SELECT d.id
  FROM public.match_map_demos d
  WHERE d.match_map_id = s.match_map_id
  ORDER BY d.metadata_parsed_at DESC NULLS LAST, d.id DESC
  LIMIT 1
)
WHERE match_map_demo_id IS NULL;

ALTER TABLE public.clip_render_jobs
  ADD CONSTRAINT clip_render_jobs_match_map_demo_id_fkey
    FOREIGN KEY (match_map_demo_id)
    REFERENCES public.match_map_demos (id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.match_clips
  ADD CONSTRAINT match_clips_match_map_demo_id_fkey
    FOREIGN KEY (match_map_demo_id)
    REFERENCES public.match_map_demos (id)
    ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.match_demo_sessions
  ADD CONSTRAINT match_demo_sessions_match_map_demo_id_fkey
    FOREIGN KEY (match_map_demo_id)
    REFERENCES public.match_map_demos (id)
    ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX clip_render_jobs_match_map_demo_id_idx
  ON public.clip_render_jobs (match_map_demo_id);

CREATE INDEX match_clips_match_map_demo_id_idx
  ON public.match_clips (match_map_demo_id);

CREATE INDEX match_demo_sessions_match_map_demo_id_idx
  ON public.match_demo_sessions (match_map_demo_id);
