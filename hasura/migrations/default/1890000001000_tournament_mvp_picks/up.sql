ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS organizer_picks_mvp boolean NOT NULL DEFAULT false;

-- Append-only: award_recipients holds the one MVP in force, this holds every
-- pick that put one there.
CREATE TABLE IF NOT EXISTS public.tournament_mvp_picks (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    player_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
    tournament_team_id uuid REFERENCES public.tournament_teams(id) ON DELETE SET NULL,
    picked_by_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    note text,
    player_impact double precision,
    automatic_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    automatic_impact double precision,
    replaced_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_tournament_mvp_picks_tournament
    ON public.tournament_mvp_picks (tournament_id, created_at DESC);
