DROP VIEW IF EXISTS v_team_reputation;

CREATE OR REPLACE VIEW v_team_reputation AS
WITH scrim_matches AS (
    SELECT
        r.match_id,
        m.status,
        m.lineup_1_id,
        m.lineup_2_id,
        r.from_team_id,
        r.to_team_id,
        r.canceled_late,
        r.canceled_by_team_id
    FROM team_scrim_requests r
    LEFT JOIN matches m ON m.id = r.match_id
    WHERE r.status = 'Matched' OR r.canceled_late = true
),
per_team AS (
    SELECT
        from_team_id AS team_id, match_id, status, lineup_1_id, lineup_2_id,
        canceled_late, canceled_by_team_id
      FROM scrim_matches
    UNION ALL
    SELECT
        to_team_id AS team_id, match_id, status, lineup_1_id, lineup_2_id,
        canceled_late, canceled_by_team_id
      FROM scrim_matches
),
classified AS (
    SELECT
        pt.team_id,
        pt.status,
        pt.canceled_late,
        (pt.canceled_late AND pt.canceled_by_team_id = pt.team_id) AS bailed,
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
    -- A no-show is a canceled scrim the team never checked into, that wasn't a
    -- deliberate late cancel (those are tracked separately, only against the
    -- team that bailed).
    count(*) FILTER (
        WHERE status = 'Canceled' AND checked_in_count = 0 AND NOT canceled_late
    ) AS no_shows,
    count(*) FILTER (WHERE bailed) AS late_cancels,
    CASE
        WHEN count(*) FILTER (
            WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
               OR (status = 'Canceled' AND checked_in_count = 0 AND NOT canceled_late)
               OR bailed
        ) = 0 THEN NULL
        ELSE round(
            100.0 * count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
            )
            / count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                   OR (status = 'Canceled' AND checked_in_count = 0 AND NOT canceled_late)
                   OR bailed
            ),
            0
        )
    END AS reliability_pct
FROM classified
GROUP BY team_id;
