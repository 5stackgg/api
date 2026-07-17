ALTER TABLE public.tournaments
    ADD COLUMN logo text,
    ADD COLUMN homepage text,
    ADD COLUMN location text,
    ADD COLUMN latitude double precision,
    ADD COLUMN longitude double precision;
