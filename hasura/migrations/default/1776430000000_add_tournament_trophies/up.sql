CREATE TABLE public.tournament_trophies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    tournament_team_id uuid NOT NULL REFERENCES public.tournament_teams(id) ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
    placement int NOT NULL CHECK (placement IN (0, 1, 2, 3)),
    placement_tier text GENERATED ALWAYS AS (
        CASE placement
            WHEN 0 THEN 'mvp'
            WHEN 1 THEN 'gold'
            WHEN 2 THEN 'silver'
            WHEN 3 THEN 'bronze'
        END
    ) STORED,
    tournament_name text NOT NULL,
    tournament_start timestamptz,
    tournament_type text,
    custom_name text,
    silhouette int CHECK (silhouette IS NULL OR (silhouette >= 0 AND silhouette <= 4)),
    image_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, tournament_team_id, player_steam_id)
);

CREATE INDEX idx_tournament_trophies_player
    ON public.tournament_trophies(player_steam_id, placement);
CREATE INDEX idx_tournament_trophies_tournament
    ON public.tournament_trophies(tournament_id);
CREATE UNIQUE INDEX tournament_trophies_one_mvp_per_tournament
    ON public.tournament_trophies(tournament_id)
    WHERE placement = 0;

CREATE TABLE public.tournament_trophy_configs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    placement int NOT NULL CHECK (placement IN (0, 1, 2, 3)),
    custom_name text,
    silhouette int CHECK (silhouette IS NULL OR (silhouette >= 0 AND silhouette <= 4)),
    image_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, placement)
);

CREATE INDEX idx_tournament_trophy_configs_tournament
    ON public.tournament_trophy_configs(tournament_id);
