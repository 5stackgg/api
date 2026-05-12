CREATE OR REPLACE FUNCTION public.get_region_veto_picking_lineup_id(match public.matches)
RETURNS uuid
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    picks_made int;
    total_picks int;
BEGIN
    IF match.status != 'Veto' THEN
        RETURN NULL;
    END IF;

    -- If a region is already locked in (e.g. only one was available so it was
    -- auto-selected, or the decider was already chosen) there's nothing left
    -- to veto — keep the UI from prompting for another pick.
    IF match.region IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT COUNT(*) INTO total_picks
    FROM match_region_veto_picks mvp
    WHERE mvp.match_id = match.id;

    picks_made := total_picks % 2;

    IF picks_made = 0 THEN
        RETURN match.lineup_1_id;
    ELSE
        RETURN match.lineup_2_id;
    END IF;
END;
$$;
