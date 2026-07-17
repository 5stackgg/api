ALTER TABLE public.match_options
    ADD COLUMN round_restart_delay integer,
    ADD COLUMN halftime_pausematch boolean NOT NULL DEFAULT false;
