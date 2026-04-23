CREATE OR REPLACE FUNCTION public.preview_tournament_match_reset(_match_id uuid)
RETURNS TABLE (
    bracket_id uuid,
    match_id uuid,
    depth int,
    round int,
    match_number int,
    path text,
    stage_type text,
    match_status text,
    is_source boolean,
    will_delete_match boolean
)
LANGUAGE plpgsql
AS $$
DECLARE
    source_bracket_id uuid;
BEGIN
    SELECT tb.id INTO source_bracket_id
    FROM tournament_brackets tb
    WHERE tb.match_id = _match_id
    LIMIT 1;

    IF source_bracket_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH RECURSIVE chain AS (
        SELECT source_bracket_id AS id, 0 AS depth
        UNION ALL
        SELECT parent.id, chain.depth + 1
        FROM chain
        JOIN tournament_brackets current_bracket ON current_bracket.id = chain.id
        JOIN tournament_brackets parent
          ON parent.id = current_bracket.parent_bracket_id
          OR parent.id = current_bracket.loser_parent_bracket_id
        WHERE parent.id IS NOT NULL
    ),
    deduped_chain AS (
        SELECT chain.id, MIN(chain.depth) AS depth
        FROM chain
        GROUP BY chain.id
    )
    SELECT
        tb.id AS bracket_id,
        tb.match_id,
        deduped_chain.depth,
        tb.round,
        tb.match_number,
        tb.path,
        ts.type AS stage_type,
        m.status AS match_status,
        tb.id = source_bracket_id AS is_source,
        (tb.id <> source_bracket_id AND tb.match_id IS NOT NULL) AS will_delete_match
    FROM deduped_chain
    JOIN tournament_brackets tb ON tb.id = deduped_chain.id
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    LEFT JOIN matches m ON m.id = tb.match_id
    ORDER BY deduped_chain.depth, tb.round, tb.match_number;
END;
$$;
