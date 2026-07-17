CREATE TABLE IF NOT EXISTS public.e_tournament_categories (
    value TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO public.e_tournament_categories (value, description) VALUES
    ('LAN', 'LAN'),
    ('LocationEvent', 'Location Event'),
    ('OnlineEvent', 'Online Event'),
    ('League', 'League')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS public.tournament_categories (
    tournament_id uuid NOT NULL
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE,
    category text NOT NULL
        REFERENCES public.e_tournament_categories(value) ON UPDATE CASCADE ON DELETE RESTRICT,
    PRIMARY KEY (tournament_id, category)
);

CREATE INDEX IF NOT EXISTS tournament_categories_tournament_id_idx
    ON public.tournament_categories (tournament_id);
