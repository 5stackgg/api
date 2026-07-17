ALTER TABLE public.teams
    ADD COLUMN is_organization boolean NOT NULL DEFAULT false;
