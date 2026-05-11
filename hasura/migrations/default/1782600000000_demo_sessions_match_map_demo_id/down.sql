DROP INDEX IF EXISTS match_demo_sessions_match_map_demo_id_idx;

ALTER TABLE public.match_demo_sessions
  DROP CONSTRAINT IF EXISTS match_demo_sessions_match_map_demo_id_fkey;

ALTER TABLE public.match_demo_sessions DROP COLUMN IF EXISTS match_map_demo_id;
