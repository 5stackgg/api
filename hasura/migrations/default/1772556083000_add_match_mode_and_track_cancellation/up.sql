ALTER TABLE public.match_options
    ADD COLUMN IF NOT EXISTS match_mode text NOT NULL DEFAULT 'auto' REFERENCES public.e_match_mode(value),
    ADD COLUMN IF NOT EXISTS auto_cancellation boolean NOT NULL DEFAULT true;
