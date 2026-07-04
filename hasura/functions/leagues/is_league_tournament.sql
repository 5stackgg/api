-- A tournament belongs to a league when it backs a division (regular season /
-- playoffs) or a cross-division relegation playoff. League tournaments must not
-- be cancelled/reset/deleted directly — the league season owns their lifecycle.
CREATE OR REPLACE FUNCTION public.is_league_tournament(_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.league_season_divisions
        WHERE tournament_id = _tournament_id
    ) OR EXISTS (
        SELECT 1 FROM public.league_relegation_playoffs
        WHERE tournament_id = _tournament_id
    );
$$;
