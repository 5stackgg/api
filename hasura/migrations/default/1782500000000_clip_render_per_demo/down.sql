DROP INDEX IF EXISTS match_clips_match_map_demo_id_idx;
DROP INDEX IF EXISTS clip_render_jobs_match_map_demo_id_idx;

ALTER TABLE public.match_clips
  DROP CONSTRAINT IF EXISTS match_clips_match_map_demo_id_fkey;

ALTER TABLE public.clip_render_jobs
  DROP CONSTRAINT IF EXISTS clip_render_jobs_match_map_demo_id_fkey;

ALTER TABLE public.match_clips DROP COLUMN IF EXISTS match_map_demo_id;
ALTER TABLE public.clip_render_jobs DROP COLUMN IF EXISTS match_map_demo_id;
