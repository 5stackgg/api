CREATE OR REPLACE FUNCTION public.auto_pick_expired_veto(
    _match_id uuid DEFAULT NULL,
    _expected_pick_count int DEFAULT NULL
) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match matches;
    _lineup_id uuid;
    _pick_type text;
    _map_id uuid;
    _side text;
    _region text;
    _available_regions text[];
    _regions text[];
    _picked boolean;
BEGIN
    -- FOR UPDATE SKIP LOCKED so a slow iteration never blocks (or gets blocked
    -- by) a real player pick landing on the same match row concurrently.
    FOR _match IN
        SELECT * FROM matches
        WHERE status = 'Veto'
          AND veto_pick_expires_at IS NOT NULL
          AND veto_pick_expires_at <= NOW()
          AND (_match_id IS NULL OR id = _match_id)
        FOR UPDATE SKIP LOCKED
    LOOP
        -- Fencing token: a timer armed for turn N must never act on turn N+1,
        -- so a job whose cancellation was missed (or that fired while we were
        -- behind on events) is inert rather than wrong. The sweep pass passes
        -- NULL and leans on the expiry predicate above instead.
        CONTINUE WHEN _expected_pick_count IS NOT NULL
                  AND veto_pick_count(_match.id) != _expected_pick_count;

        _picked := false;

        -- Subtransaction per match: verify_region_veto_pick and
        -- get_map_veto_picking_lineup_id both RAISE on states we can legitimately
        -- observe, and one bad match must not roll back the rest of the batch.
        BEGIN
            IF _match.region IS NULL THEN
                _lineup_id := get_region_veto_picking_lineup_id(_match);

                IF _lineup_id IS NOT NULL THEN
                    _regions := sanitize_match_options_regions(_match.match_options_id);

                    SELECT array_agg(r) INTO _available_regions
                    FROM unnest(_regions) AS r
                    WHERE NOT EXISTS (
                        SELECT 1 FROM match_region_veto_picks mvp
                        WHERE mvp.match_id = _match.id AND lower(mvp.region) = lower(r)
                    );

                    -- Strictly greater than one: verify_region_veto_pick refuses to
                    -- ban the last available region, and auto_select_region_veto
                    -- locks that one in by itself.
                    IF COALESCE(array_length(_available_regions, 1), 0) > 1 THEN
                        _region := _available_regions[
                            1 + floor(random() * array_length(_available_regions, 1))::int
                        ];

                        INSERT INTO match_region_veto_picks
                            (match_id, type, match_lineup_id, region, auto_picked)
                            VALUES (_match.id, 'Ban', _lineup_id, _region, true);

                        _picked := true;
                    END IF;
                END IF;
            ELSE
                _pick_type := get_map_veto_type(_match);

                IF _pick_type IS NOT NULL THEN
                    _lineup_id := get_map_veto_picking_lineup_id(_match);
                END IF;

                IF _pick_type IS NOT NULL AND _lineup_id IS NOT NULL THEN
                    IF _pick_type = 'Side' THEN
                        SELECT map_id INTO _map_id
                        FROM match_map_veto_picks
                        WHERE match_id = _match.id AND type = 'Pick'
                        ORDER BY created_at DESC
                        LIMIT 1;

                        IF _map_id IS NOT NULL THEN
                            _side := CASE WHEN random() < 0.5 THEN 'CT' ELSE 'TERRORIST' END;

                            INSERT INTO match_map_veto_picks
                                (match_id, type, match_lineup_id, map_id, side, auto_picked)
                                VALUES (_match.id, 'Side', _lineup_id, _map_id, _side, true);

                            _picked := true;
                        END IF;
                    ELSE
                        SELECT mp.map_id INTO _map_id
                        FROM match_options mo
                        INNER JOIN _map_pool mp ON mp.map_pool_id = mo.map_pool_id
                        LEFT JOIN match_map_veto_picks mvp
                               ON mvp.match_id = _match.id AND mvp.map_id = mp.map_id
                        WHERE mo.id = _match.match_options_id AND mvp IS NULL
                        ORDER BY random()
                        LIMIT 1;

                        IF _map_id IS NOT NULL THEN
                            INSERT INTO match_map_veto_picks
                                (match_id, type, match_lineup_id, map_id, auto_picked)
                                VALUES (_match.id, _pick_type, _lineup_id, _map_id, true);

                            _picked := true;
                        END IF;
                    END IF;
                END IF;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            _picked := false;
            RAISE WARNING 'auto_pick_expired_veto failed for match %: %', _match.id, SQLERRM;
        END;

        -- Nothing was inserted, so no AFTER INSERT trigger refreshed the deadline.
        -- Clearing it is what stops this match being re-swept on every single pass
        -- for the rest of its life.
        IF NOT _picked THEN
            UPDATE matches SET veto_pick_expires_at = NULL WHERE id = _match.id;
        END IF;
    END LOOP;
END;
$$;
