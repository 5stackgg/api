CREATE OR REPLACE FUNCTION public.veto_pick_count(_match_id uuid) RETURNS int
    LANGUAGE sql STABLE
    AS $$
    SELECT (SELECT COUNT(*) FROM match_region_veto_picks WHERE match_id = _match_id)::int
         + (SELECT COUNT(*) FROM match_map_veto_picks    WHERE match_id = _match_id)::int;
$$;
