CREATE OR REPLACE FUNCTION public.verify_map_veto_pick(match_map_veto_pick match_map_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    pickType VARCHAR(255);
    lineup_id uuid;
    picked_map_id uuid;
    _match matches;
    map_pool uuid[];
    use_active_pool BOOLEAN;
BEGIN
    -- TOOD - https://github.com/ValveSoftware/counter-strike_rules_and_regs/blob/main/major-supplemental-rulebook.md#map-pick-ban
    -- FOR UPDATE serializes concurrent veto picks for the same match so the
    -- turn/type count can't race between two simultaneous inserts.
    select * into _match from matches where id = match_map_veto_pick.match_id FOR UPDATE;

    -- Get map pool for the match
    pickType := get_map_veto_type(_match);

    -- No active step (match not in Veto, or map veto disabled): reject rather
    -- than let the NULL propagate through the comparisons below, where every
    -- guard would silently pass.
    IF pickType IS NULL THEN
        RAISE EXCEPTION 'No map veto in progress' USING ERRCODE = '22000';
    END IF;

    -- Check if the pickType matches the type of the match_map_veto_pick veto
    IF match_map_veto_pick.type != pickType THEN
        RAISE EXCEPTION 'Expected pick type of %', pickType USING ERRCODE = '22000';
    END IF;

    -- Get the lineup_id for the match
    SELECT * INTO lineup_id FROM get_map_veto_picking_lineup_id(_match);

    -- Check if the lineup_id matches the lineup_id provided in the match_map_veto_pick veto
    IF match_map_veto_pick.match_lineup_id != lineup_id THEN
        RAISE EXCEPTION 'Expected other lineup for %, %', pickType, lineup_id USING ERRCODE = '22000';
    END IF;

    -- Ensure that a side is picked for 'Side' type veto
    IF pickType = 'Side' THEN
        IF match_map_veto_pick.side IS NULL THEN
            RAISE EXCEPTION 'Must pick a side' USING ERRCODE = '22000';
        END IF;

        -- A Side answers the Pick before it and nothing else. Unchecked, the
        -- side could be recorded against the leftover map -- the decider, which
        -- no one ever picks sides on -- leaving the picked map unplayed and the
        -- veto stuck on a Decider step with no maps left to satisfy it.
        -- Picks and sides alternate, so only one picked map is ever waiting on
        -- a side. Matched on the rows themselves rather than the latest
        -- created_at, which ties when picks share a transaction.
        SELECT mvp.map_id INTO picked_map_id
        FROM match_map_veto_picks mvp
        WHERE mvp.match_id = match_map_veto_pick.match_id
          AND mvp.type = 'Pick'
          AND NOT EXISTS (
              SELECT 1
              FROM match_map_veto_picks sided
              WHERE sided.match_id = mvp.match_id
                AND sided.map_id = mvp.map_id
                AND sided.type = 'Side'
          )
        LIMIT 1;

        IF match_map_veto_pick.map_id IS DISTINCT FROM picked_map_id THEN
            RAISE EXCEPTION 'Must pick a side for the map that was just picked' USING ERRCODE = '22000';
        END IF;
    END IF;

    -- Ensure that a side is not picked for 'Pick' or 'Ban' type veto
    IF pickType = 'Pick' OR pickType = 'Ban' THEN
        IF match_map_veto_pick.side IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot % and choose side', pickType USING ERRCODE = '22000';
        END IF;
    END IF;

    -- Check if the map being picked is available for the match
    IF NOT EXISTS (
        SELECT 1 FROM matches m
        INNER JOIN match_options mo on mo.id = m.match_options_id
        INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
        INNER JOIN maps ON maps.id = mp.map_id
        WHERE maps.id = match_map_veto_pick.map_id AND m.id = match_map_veto_pick.match_id
    ) THEN
        RAISE EXCEPTION 'Map not available for picking' USING ERRCODE = '22000';
    END IF;
END;
$$;