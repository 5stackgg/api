-- Windows are seeded once by start_league_season. Admins can still edit the
-- season's match weeks after kickoff, so keep the per-division stage windows in
-- step: proposal validation and the default-time fallback both read the windows,
-- not league_match_weeks, and would otherwise silently use the pre-start times.
CREATE OR REPLACE FUNCTION public.tau_league_match_weeks() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _gpw int;
BEGIN
    SELECT COALESCE(games_per_week, 1) INTO _gpw
    FROM public.league_seasons
    WHERE id = NEW.league_season_id;

    UPDATE public.tournament_stage_windows tsw
    SET opens_at = NEW.opens_at,
        closes_at = NEW.closes_at,
        default_match_at = LEAST(
            NEW.default_match_at + ((slot.n - 1) * INTERVAL '3 days'),
            COALESCE(NEW.closes_at, NEW.default_match_at + ((slot.n - 1) * INTERVAL '3 days'))
        )
    FROM public.league_season_divisions lsd
    JOIN public.tournament_stages ts
      ON ts.tournament_id = lsd.tournament_id AND ts."order" = 1
    CROSS JOIN generate_series(1, _gpw) AS slot(n)
    WHERE lsd.league_season_id = NEW.league_season_id
      AND tsw.tournament_stage_id = ts.id
      AND tsw.round = (NEW.week_number - 1) * _gpw + slot.n;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tau_league_match_weeks ON public.league_match_weeks;
CREATE TRIGGER tau_league_match_weeks
    AFTER UPDATE ON public.league_match_weeks
    FOR EACH ROW
    WHEN (
        NEW.opens_at IS DISTINCT FROM OLD.opens_at
        OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
        OR NEW.default_match_at IS DISTINCT FROM OLD.default_match_at
    )
    EXECUTE FUNCTION public.tau_league_match_weeks();
