ALTER TABLE public.match_options
    ADD COLUMN auto_cancel_duration integer CHECK (auto_cancel_duration > 0),
    ADD COLUMN live_match_timeout integer CHECK (live_match_timeout > 0);
