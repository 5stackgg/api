ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS auto_cancel_duration integer CHECK (auto_cancel_duration > 0),
    ADD COLUMN IF NOT EXISTS live_match_timeout integer CHECK (live_match_timeout > 0);
