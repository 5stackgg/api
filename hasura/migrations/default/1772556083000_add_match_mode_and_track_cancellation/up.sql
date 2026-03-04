ALTER TABLE public.match_options
    ADD COLUMN match_mode text NOT NULL DEFAULT 'auto' REFERENCES public.e_match_mode(value),
    ADD COLUMN track_cancellation boolean NOT NULL DEFAULT true;
