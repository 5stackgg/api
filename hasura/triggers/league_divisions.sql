-- Replaces the earlier per-row deactivation guard.
DROP TRIGGER IF EXISTS tbu_league_divisions ON public.league_divisions;
DROP FUNCTION IF EXISTS public.tbu_league_divisions();

-- Divisions have no active flag: every tier in the ladder is a valid promotion
-- and relegation target, it simply may have no teams in a given season. These
-- drops clear the guard that enforced the old "keep two active" rule.
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
