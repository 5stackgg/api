-- Divisions cannot be disabled: every tier is a promotion and relegation target
-- and simply may have no teams in a given season. Nothing recreates these two
-- guards; the drops exist to remove them from databases that installed them.
DROP TRIGGER IF EXISTS tbu_league_divisions ON public.league_divisions;
DROP FUNCTION IF EXISTS public.tbu_league_divisions();
DROP TRIGGER IF EXISTS enforce_min_active_league_divisions ON public.league_divisions;
DROP FUNCTION IF EXISTS public.enforce_min_active_league_divisions();

-- Keep tiers contiguous (1..N by current order) after a division is removed.
CREATE OR REPLACE FUNCTION public.renumber_league_divisions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.league_divisions d
    SET tier = o.rn
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY tier) AS rn
        FROM public.league_divisions
    ) o
    WHERE d.id = o.id AND d.tier <> o.rn;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS renumber_league_divisions ON public.league_divisions;
CREATE TRIGGER renumber_league_divisions
    AFTER DELETE ON public.league_divisions
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.renumber_league_divisions();
