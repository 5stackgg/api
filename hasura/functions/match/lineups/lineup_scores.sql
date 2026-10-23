-- The latest round's score, kept on match_maps by
-- hasura/triggers/match_map_rounds.sql. One expression each, so they inline as
-- column reads.
CREATE OR REPLACE FUNCTION public.lineup_1_score(match_map public.match_maps) RETURNS integer
    LANGUAGE sql STABLE
    AS $$ SELECT match_map.lineup_1_rounds_won $$;

CREATE OR REPLACE FUNCTION public.lineup_2_score(match_map public.match_maps) RETURNS integer
    LANGUAGE sql STABLE
    AS $$ SELECT match_map.lineup_2_rounds_won $$;

-- Rewrites these maps' stored scores (all maps when NULL) from their latest
-- round that hasn't been deleted, 0-0 when there is none.
CREATE OR REPLACE FUNCTION public.refresh_match_map_scores(_match_map_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF cardinality(_match_map_ids) = 0 THEN
        RETURN;
    END IF;

    -- Locking the maps first queues this behind another transaction still
    -- writing their rounds, so the update below, a statement of its own, reads
    -- them once that one has committed. NO KEY, so it doesn't deadlock with
    -- the key-share lock each round insert holds on its map.
    PERFORM 1
    FROM public.match_maps
    WHERE _match_map_ids IS NULL OR id = ANY (_match_map_ids)
    ORDER BY id
    FOR NO KEY UPDATE;

    UPDATE public.match_maps mm
    SET lineup_1_rounds_won = COALESCE(latest.lineup_1_score, 0),
        lineup_2_rounds_won = COALESCE(latest.lineup_2_score, 0)
    FROM public.match_maps target
    LEFT JOIN LATERAL (
        SELECT mmr.lineup_1_score, mmr.lineup_2_score
        FROM public.match_map_rounds mmr
        WHERE mmr.match_map_id = target.id
          AND mmr.deleted_at IS NULL
        ORDER BY mmr.time DESC
        LIMIT 1
    ) latest ON true
    WHERE mm.id = target.id
      AND (_match_map_ids IS NULL OR target.id = ANY (_match_map_ids))
      AND (mm.lineup_1_rounds_won, mm.lineup_2_rounds_won)
          IS DISTINCT FROM (COALESCE(latest.lineup_1_score, 0), COALESCE(latest.lineup_2_score, 0));
END;
$$;
