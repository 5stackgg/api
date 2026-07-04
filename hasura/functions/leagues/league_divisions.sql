-- Reorder the division ladder from a drag-and-drop: tiers are reassigned by the
-- position of each id in _division_ids (1 = top). A single UPDATE permutes the
-- tiers, relying on the deferrable unique constraint to allow the swap.
CREATE OR REPLACE FUNCTION public.reorder_league_divisions(
    _division_ids uuid[],
    hasura_session json
)
RETURNS SETOF public.league_divisions
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT public.is_league_admin_for_session(hasura_session) THEN
        RAISE EXCEPTION 'Must be a league admin' USING ERRCODE = '22000';
    END IF;

    UPDATE public.league_divisions d
    SET tier = pos.rn
    FROM (
        SELECT id, ordinality AS rn
        FROM unnest(_division_ids) WITH ORDINALITY AS t(id, ordinality)
    ) pos
    WHERE d.id = pos.id
      AND d.tier <> pos.rn;

    RETURN QUERY SELECT * FROM public.league_divisions ORDER BY tier;
END;
$$;
