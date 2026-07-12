ALTER TABLE public.events
    ALTER COLUMN starts_at DROP NOT NULL;

ALTER TABLE public.events
    ALTER COLUMN starts_at DROP DEFAULT;
