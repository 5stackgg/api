-- The lineup a veto is waiting on when nothing will move it along by itself,
-- or NULL when nobody is to blame. A veto clock auto-picks a stalling side, so
-- with one running the veto only overruns because it was slow as a whole.
-- cancels_at covers the whole veto, so a side that holds its turn to the last
-- second and then picks would hand the blame to the other: the side waited on
-- must have held the veto for at least half the window, counted from the other
-- side's last step. A side can take two steps in a row, and Deciders are
-- placed, not taken.
-- Mirrors auto_pick_expired_veto: no region left to ban and no map step to take
-- are nobody's turn, and the veto functions RAISE on states a pool edit can
-- leave behind, which must not stop the expiry job for every other match.
CREATE OR REPLACE FUNCTION public.veto_stalled_by(_match_id uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match matches;
    _timeout int;
    _window int;
    _turn_opened timestamptz;
    _lineup_id uuid;
    _available int;
BEGIN
    SELECT * INTO _match FROM matches WHERE id = _match_id;

    IF NOT FOUND OR _match.status != 'Veto' THEN
        RETURN NULL;
    END IF;

    SELECT veto_pick_timeout INTO _timeout
    FROM match_options WHERE id = _match.match_options_id;

    IF COALESCE(_timeout, 0) > 0 THEN
        RETURN NULL;
    END IF;

    BEGIN
        IF _match.region IS NULL THEN
            SELECT COUNT(*) INTO _available
            FROM unnest(sanitize_match_options_regions(_match.match_options_id)) AS r
            WHERE NOT EXISTS (
                SELECT 1 FROM match_region_veto_picks mvp
                WHERE mvp.match_id = _match.id AND lower(mvp.region) = lower(r)
            );

            IF _available <= 1 THEN
                RETURN NULL;
            END IF;

            _lineup_id := get_region_veto_picking_lineup_id(_match);
        ELSIF get_map_veto_type(_match) IS NOT NULL THEN
            _lineup_id := get_map_veto_picking_lineup_id(_match);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    IF _lineup_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(auto_cancel_duration, get_int_setting('auto_cancel_duration', 15))
    INTO _window
    FROM resolve_match_auto_cancel(_match_id);

    SELECT GREATEST(
        (SELECT MAX(created_at) FROM match_map_veto_picks
         WHERE match_id = _match_id AND type != 'Decider' AND match_lineup_id != _lineup_id),
        (SELECT MAX(created_at) FROM match_region_veto_picks
         WHERE match_id = _match_id AND type != 'Decider' AND match_lineup_id != _lineup_id)
    ) INTO _turn_opened;

    IF _turn_opened IS NOT NULL
       AND NOW() - _turn_opened < make_interval(secs => COALESCE(_window, 15) * 30) THEN
        RETURN NULL;
    END IF;

    RETURN _lineup_id;
END;
$$;
