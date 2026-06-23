DROP VIEW IF EXISTS v_team_reputation;

CREATE OR REPLACE VIEW v_team_reputation AS
WITH scrim_matches AS (
    SELECT
        r.match_id,
        m.status,
        m.lineup_1_id,
        m.lineup_2_id,
        r.from_team_id,
        r.to_team_id
    FROM team_scrim_requests r
    JOIN matches m ON m.id = r.match_id
    WHERE r.status = 'Matched'
),
per_team AS (
    SELECT from_team_id AS team_id, match_id, status, lineup_1_id, lineup_2_id
      FROM scrim_matches
    UNION ALL
    SELECT to_team_id AS team_id, match_id, status, lineup_1_id, lineup_2_id
      FROM scrim_matches
),
classified AS (
    SELECT
        pt.team_id,
        pt.status,
        (
            SELECT count(*)
              FROM match_lineup_players mlp
              JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
             WHERE ml.id IN (pt.lineup_1_id, pt.lineup_2_id)
               AND ml.team_id = pt.team_id
               AND mlp.checked_in = true
        ) AS checked_in_count
    FROM per_team pt
)
SELECT
    team_id,
    count(*) FILTER (
        WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
    ) AS scrims_completed,
    count(*) FILTER (
        WHERE status = 'Canceled' AND checked_in_count = 0
    ) AS no_shows,
    0 AS late_cancels,
    CASE
        WHEN count(*) FILTER (
            WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
               OR (status = 'Canceled' AND checked_in_count = 0)
        ) = 0 THEN NULL
        ELSE round(
            100.0 * count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
            )
            / count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                   OR (status = 'Canceled' AND checked_in_count = 0)
            ),
            0
        )
    END AS reliability_pct
FROM classified
GROUP BY team_id;
