ALTER TABLE public.match_options RENAME COLUMN track_cancellation TO match_cancellation;

ALTER TABLE public.match_options
    ADD COLUMN auto_cancel_duration integer,
    ADD COLUMN live_match_timeout integer;
