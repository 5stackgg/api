CREATE OR REPLACE FUNCTION public.suggest_player_groups(
    window_days int DEFAULT 30,
    pair_threshold int DEFAULT 8,
    max_group_size int DEFAULT 5,
    group_threshold int DEFAULT 3
)
RETURNS TABLE(member_steam_ids bigint[], together_count int)
LANGUAGE sql STABLE
AS $$
WITH eligible AS (
    -- Only suggest teams to real users who have actually signed in and are not
    -- already on a team. Players auto-created by match imports/events (never
    -- logged in) have a null last_sign_in_at and must be ignored.
    SELECT pl.steam_id
    FROM players pl
    WHERE pl.last_sign_in_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM team_roster tr WHERE tr.player_steam_id = pl.steam_id
      )
),
pairs AS (
    SELECT
        p1.steam_id AS anchor,
        p2.steam_id AS partner,
        count(DISTINCT p1.match_lineup_id) AS cnt
    FROM match_lineup_players p1
    JOIN match_lineup_players p2
      ON p2.match_lineup_id = p1.match_lineup_id
     AND p2.steam_id <> p1.steam_id
    JOIN match_lineups l ON l.id = p1.match_lineup_id
    JOIN matches m ON m.id = l.match_id
    WHERE m.created_at >= now() - (window_days || ' days')::interval
      AND m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
      AND p1.steam_id IN (SELECT steam_id FROM eligible)
      AND p2.steam_id IN (SELECT steam_id FROM eligible)
    GROUP BY p1.steam_id, p2.steam_id
    HAVING count(DISTINCT p1.match_lineup_id) >= pair_threshold
),
candidate AS (
    SELECT
        ARRAY[anchor]
            || (array_agg(partner ORDER BY cnt DESC))[1:max_group_size - 1] AS members
    FROM pairs
    GROUP BY anchor
),
normalized AS (
    SELECT DISTINCT (
        SELECT array_agg(x ORDER BY x) FROM unnest(members) AS x
    ) AS members
    FROM candidate
    WHERE array_length(members, 1) >= 3
),
counted AS (
    SELECT
        n.members,
        (
            SELECT count(*)::int FROM (
                SELECT p.match_lineup_id
                FROM match_lineup_players p
                JOIN match_lineups l ON l.id = p.match_lineup_id
                JOIN matches m ON m.id = l.match_id
                WHERE p.steam_id = ANY (n.members)
                  AND m.created_at >= now() - (window_days || ' days')::interval
                  AND m.status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                GROUP BY p.match_lineup_id
                HAVING count(DISTINCT p.steam_id) = array_length(n.members, 1)
            ) shared
        ) AS together_count
    FROM normalized n
)
SELECT c.members AS member_steam_ids, c.together_count
FROM counted c
WHERE c.together_count >= group_threshold;
$$;
