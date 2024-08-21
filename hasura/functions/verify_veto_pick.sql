CREATE OR REPLACE FUNCTION public.verify_veto_pick(match_veto_pick match_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    pickType VARCHAR(255);
    lineup_id uuid;
    _match matches;
    map_pool uuid[];
    use_active_pool BOOLEAN;
BEGIN
    -- TOOD - https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban
    -- Get match_id and match_lineup_id from match_veto_pick depending on their availability
    select * into _match from matches where id = match_veto_pick.match_id;

    -- Get map pool for the match
    pickType := get_veto_type(_match);

    -- Check if the pickType matches the type of the match_veto_pick veto
    IF match_veto_pick.type != pickType THEN
        RAISE EXCEPTION 'Expected pick type of %', pickType USING ERRCODE = '22000';
    END IF;

    -- Get the lineup_id for the match
    SELECT * INTO lineup_id FROM get_veto_picking_lineup_id(_match);

    -- Check if the lineup_id matches the lineup_id provided in the match_veto_pick veto
    IF match_veto_pick.match_lineup_id != lineup_id THEN
        RAISE EXCEPTION 'Expected other lineup for %, %', pickType, lineup_id USING ERRCODE = '22000';
    END IF;

    -- Ensure that a side is picked for 'Side' type veto
    IF pickType = 'Side' AND match_veto_pick.side IS NULL THEN
        RAISE EXCEPTION 'Must pick a side' USING ERRCODE = '22000';
    END IF;

    -- Ensure that a side is not picked for 'Pick' or 'Ban' type veto
    IF pickType = 'Pick' OR pickType = 'Ban' THEN
        IF match_veto_pick.side IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot % and choose side', pickType USING ERRCODE = '22000';
        END IF;
    END IF;

    -- Check if the map being picked is available for the match
    IF NOT EXISTS (
        SELECT 1 FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        INNER JOIN maps ON maps.id = mp.map_id
        WHERE maps.id = match_veto_pick.map_id AND m.id = match_veto_pick.match_id
    ) THEN
        RAISE EXCEPTION 'Map not available for picking' USING ERRCODE = '22000';
    END IF;
END;
$$;