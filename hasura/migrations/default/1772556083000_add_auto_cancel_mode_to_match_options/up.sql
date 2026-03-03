ALTER TABLE public.match_options
    ADD COLUMN auto_cancel_mode text NOT NULL DEFAULT 'AutoCancel'
    REFERENCES public.e_auto_cancel_mode(value);
