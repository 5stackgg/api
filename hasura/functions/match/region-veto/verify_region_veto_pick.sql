CREATE OR REPLACE FUNCTION public.verify_region_veto_pick(match_region_veto_pick match_region_veto_picks) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    lineup_id uuid;
    _match matches;
    available_count int;
BEGIN
    -- FOR UPDATE serializes concurrent veto picks for the same match so the
    -- turn count can't race between two simultaneous inserts.
    select * into _match from matches where id = match_region_veto_pick.match_id FOR UPDATE;

    -- Get the lineup_id for the match
    SELECT * INTO lineup_id FROM get_region_veto_picking_lineup_id(_match);

    -- Check if the lineup_id matches the lineup_id provided in the match_region_veto_pick veto
    IF match_region_veto_pick.match_lineup_id != lineup_id THEN
        RAISE EXCEPTION 'Expected other lineup for %', lineup_id USING ERRCODE = '22000';
    END IF;

    -- A Ban must leave at least one region pickable; never let the last
    -- available region be banned (would leave the match unstartable).
    IF match_region_veto_pick.type = 'Ban' THEN
        SELECT COUNT(*) INTO available_count
        FROM unnest(sanitize_match_options_regions(_match.match_options_id)) AS r
        WHERE NOT EXISTS (
            SELECT 1
            FROM match_region_veto_picks mvp
            WHERE mvp.match_id = match_region_veto_pick.match_id
              AND lower(mvp.region) = lower(r)
        );

        IF available_count <= 1 THEN
            RAISE EXCEPTION 'Cannot ban the last available region' USING ERRCODE = '22000';
        END IF;
    END IF;
END;
$$;