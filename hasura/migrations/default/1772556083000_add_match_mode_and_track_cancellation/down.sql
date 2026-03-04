ALTER TABLE public.match_options
    DROP COLUMN IF EXISTS match_mode,
    DROP COLUMN IF EXISTS track_cancellation;
