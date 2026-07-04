-- Replaces the earlier per-row deactivation guard.
DROP TRIGGER IF EXISTS tbu_league_divisions ON public.league_divisions;
DROP FUNCTION IF EXISTS public.tbu_league_divisions();

-- The division ladder needs at least two active divisions for promotion and
-- relegation to have somewhere to go. Block any deactivate/delete that would
-- leave exactly one active (drop to zero to turn the ladder off entirely).
-- Statement-level so a bulk delete straight to zero passes; INSERT is left
-- unguarded so the ladder can be built up one division at a time.
CREATE OR REPLACE FUNCTION public.enforce_min_active_league_divisions() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (SELECT COUNT(*) FROM public.league_divisions WHERE active) = 1 THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Keep at least two divisions active so teams can be promoted and relegated';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enforce_min_active_league_divisions ON public.league_divisions;
CREATE TRIGGER enforce_min_active_league_divisions
    AFTER UPDATE OR DELETE ON public.league_divisions
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.enforce_min_active_league_divisions();

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
