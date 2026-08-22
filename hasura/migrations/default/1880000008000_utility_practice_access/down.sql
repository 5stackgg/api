DROP INDEX IF EXISTS public.utility_practice_sessions_access_idx;

ALTER TABLE public.utility_practice_sessions
    DROP CONSTRAINT IF EXISTS utility_practice_sessions_access_fkey;

ALTER TABLE public.utility_practice_sessions
    DROP COLUMN IF EXISTS access;

DROP TABLE IF EXISTS public.e_utility_practice_access;
