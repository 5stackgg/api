CREATE OR REPLACE FUNCTION public.refresh_veto_pick_expiry(_match_id uuid) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    _timeout int;
BEGIN
    SELECT mo.veto_pick_timeout INTO _timeout
    FROM matches m
    INNER JOIN match_options mo ON mo.id = m.match_options_id
    WHERE m.id = _match_id;

    -- Guarded on status so this only bumps while veto is actually running:
    -- create_match_map_from_veto / auto_select_region_veto may have already
    -- flipped the match to Live in this same statement, in which case the
    -- timer is meaningless and tbu_matches has already nulled it.
    UPDATE matches
    SET veto_pick_expires_at = CASE
            WHEN COALESCE(_timeout, 0) > 0 THEN NOW() + (_timeout || ' seconds')::interval
            ELSE NULL
        END
    WHERE id = _match_id AND status = 'Veto';
END;
$$;
