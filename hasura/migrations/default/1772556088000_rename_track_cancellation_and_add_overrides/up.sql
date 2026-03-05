ALTER TABLE public.match_options
    ADD COLUMN auto_cancel_duration integer,
    ADD COLUMN live_match_timeout integer;
