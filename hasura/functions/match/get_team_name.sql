-- A lineup's name: its own team name or its team's, else the name of the
-- tournament team its bracket put in that slot, else Team 1 / Team 2.
CREATE OR REPLACE FUNCTION public.compute_match_lineup_name(_lineup_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (
            SELECT COALESCE(ml.team_name, t.name)
            FROM matches m
            JOIN match_lineups ml ON ml.match_id = m.id
            LEFT JOIN teams t ON t.id = ml.team_id
            WHERE ml.id = _lineup_id
        ),
        (
            SELECT COALESCE(tt.name, t2.name)
            FROM matches m
            JOIN tournament_brackets tb ON tb.match_id = m.id
            JOIN tournament_teams tt ON
                (_lineup_id = m.lineup_1_id AND tt.id = tb.tournament_team_id_1)
                OR
                (_lineup_id = m.lineup_2_id AND tt.id = tb.tournament_team_id_2)
            LEFT JOIN teams t2 ON t2.id = tt.team_id
            WHERE m.id = (SELECT match_id FROM match_lineups WHERE id = _lineup_id)
            LIMIT 1
        ),
        CASE
            WHEN _lineup_id = (
                SELECT m.lineup_1_id
                FROM matches m
                JOIN match_lineups ml ON ml.match_id = m.id
                WHERE ml.id = _lineup_id
            ) THEN 'Team 1'
            ELSE 'Team 2'
        END
    );
$$;

-- Kept on match_lineups.display_name (hasura/triggers/match_lineup_names.sql,
-- backfilled by migration 1890000001400).
-- One expression, so it inlines as a column read; a lineup not stored yet is
-- worked out on the spot.
CREATE OR REPLACE FUNCTION public.get_team_name(
    match_lineup public.match_lineups
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(match_lineup.display_name, public.compute_match_lineup_name(match_lineup.id));
$$;

-- Rewrites these lineups' stored names (all lineups when NULL).
CREATE OR REPLACE FUNCTION public.refresh_match_lineup_names(_lineup_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF cardinality(_lineup_ids) = 0 THEN
        RETURN;
    END IF;

    -- Queues behind another transaction still changing what these names come
    -- from, so the update below reads it once that one has committed.
    PERFORM 1
    FROM public.match_lineups
    WHERE _lineup_ids IS NULL OR id = ANY (_lineup_ids)
    ORDER BY id
    FOR NO KEY UPDATE;

    UPDATE public.match_lineups ml
    SET display_name = named.name
    FROM (
        SELECT id, public.compute_match_lineup_name(id) AS name
        FROM public.match_lineups
        WHERE _lineup_ids IS NULL OR id = ANY (_lineup_ids)
    ) named
    WHERE ml.id = named.id
      AND ml.display_name IS DISTINCT FROM named.name;
END;
$$;

-- Both lineups of these matches, by the match's slots and by lineups pointing
-- at the match.
CREATE OR REPLACE FUNCTION public.match_lineup_ids(_match_ids uuid[])
RETURNS uuid[]
LANGUAGE sql
STABLE
AS $$
    SELECT ARRAY(
        SELECT lineup_id FROM (
            SELECT unnest(ARRAY[m.lineup_1_id, m.lineup_2_id]) AS lineup_id
            FROM matches m WHERE m.id = ANY (_match_ids)
            UNION
            SELECT ml.id FROM match_lineups ml WHERE ml.match_id = ANY (_match_ids)
        ) ids
        WHERE lineup_id IS NOT NULL
    );
$$;
