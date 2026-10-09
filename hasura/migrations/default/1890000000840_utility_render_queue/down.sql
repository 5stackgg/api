ALTER TABLE public.utility_practice_sessions
    DROP COLUMN IF EXISTS render_seen_at,
    DROP COLUMN IF EXISTS render_job_name;

ALTER TABLE public.utility_lineup_renders
    DROP COLUMN IF EXISTS render_version;

ALTER TABLE public.utility_lineups
    DROP COLUMN IF EXISTS preview_version;
