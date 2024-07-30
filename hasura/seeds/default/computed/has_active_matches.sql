CREATE OR REPLACE FUNCTION public.has_active_matches(match_options public.match_options) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    match_exists boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM match_options mo
        INNER JOIN matches m ON m.match_options_id = mo.id
        WHERE mo.id = match_options.id AND m.status != 'PickingPlayers'
    ) INTO match_exists;
    RETURN match_exists;
END;
$$;