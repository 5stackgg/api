CREATE OR REPLACE FUNCTION public.get_draft_game_picking_lineup_id(dg public.draft_games) RETURNS int
    LANGUAGE plpgsql STABLE
AS $$
DECLARE
    pattern int[];
    picks_made int;
BEGIN
    IF dg.status != 'Drafting' THEN
        RETURN NULL;
    END IF;

    pattern := get_draft_game_pattern(dg);

    SELECT count(*) INTO picks_made
    FROM draft_game_picks
    WHERE draft_game_id = dg.id;

    IF picks_made + 1 > coalesce(array_length(pattern, 1), 0) THEN
        RETURN NULL;
    END IF;

    RETURN pattern[picks_made + 1];
END;
$$;
