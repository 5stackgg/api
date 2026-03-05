ALTER TABLE public.match_options
    DROP COLUMN IF EXISTS auto_cancel_duration,
    DROP COLUMN IF EXISTS live_match_timeout;
