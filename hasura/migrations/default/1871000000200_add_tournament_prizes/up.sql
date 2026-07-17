CREATE TABLE IF NOT EXISTS public.tournament_prizes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL
        REFERENCES public.tournaments(id) ON UPDATE CASCADE ON DELETE CASCADE,
    place text NOT NULL,
    prize text NOT NULL,
    "order" integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_prizes_tournament_id_idx
    ON public.tournament_prizes (tournament_id);
