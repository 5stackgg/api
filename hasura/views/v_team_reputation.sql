DROP VIEW IF EXISTS v_team_reputation;

CREATE OR REPLACE VIEW v_team_reputation AS
WITH scrim_matches AS (
    SELECT
        r.match_id,
        -- Prefer the live match status; fall back to the snapshot frozen onto
        -- the request when the match was deleted. Canceled scrim matches are
        -- GC'd ~1 day after cancellation, so the row we'd join to is gone.
        COALESCE(m.status, r.match_outcome) AS status,
        (m.id IS NOT NULL) AS match_present,
        m.lineup_1_id,
        m.lineup_2_id,
        r.from_team_id,
        r.to_team_id,
        r.canceled_late,
        r.canceled_by_team_id,
        r.from_team_checked_in,
        r.to_team_checked_in
    FROM team_scrim_requests r
    LEFT JOIN matches m ON m.id = r.match_id
    WHERE r.status = 'Matched'
       OR r.canceled_late = true
       OR r.match_outcome IS NOT NULL
),
per_team AS (
    SELECT
        from_team_id AS team_id, match_present, status, lineup_1_id, lineup_2_id,
        canceled_late, canceled_by_team_id,
        from_team_checked_in AS team_checked_in
      FROM scrim_matches
    UNION ALL
    SELECT
        to_team_id AS team_id, match_present, status, lineup_1_id, lineup_2_id,
        canceled_late, canceled_by_team_id,
        to_team_checked_in AS team_checked_in
      FROM scrim_matches
),
classified AS (
    SELECT
        pt.team_id,
        pt.status,
        pt.canceled_late,
        (pt.canceled_late AND pt.canceled_by_team_id = pt.team_id) AS bailed,
        -- While the match exists, read check-in live; once it's GC'd, use the
        -- boolean snapshot frozen at delete time.
        CASE
            WHEN pt.match_present THEN EXISTS (
                SELECT 1
                  FROM match_lineup_players mlp
                  JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
                 WHERE ml.id IN (pt.lineup_1_id, pt.lineup_2_id)
                   AND ml.team_id = pt.team_id
                   AND mlp.checked_in = true
            )
            ELSE COALESCE(pt.team_checked_in, false)
        END AS checked_in
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
        WHERE status = 'Canceled' AND NOT checked_in AND NOT canceled_late
    ) AS no_shows,
    count(*) FILTER (WHERE bailed) AS late_cancels,
    CASE
        WHEN count(*) FILTER (
            WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
               OR (status = 'Canceled' AND NOT checked_in AND NOT canceled_late)
               OR bailed
        ) = 0 THEN NULL
        ELSE round(
            100.0 * count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
            )
            / count(*) FILTER (
                WHERE status IN ('Finished', 'Tie', 'Forfeit', 'Surrendered')
                   OR (status = 'Canceled' AND NOT checked_in AND NOT canceled_late)
                   OR bailed
            ),
            0
        )
    END AS reliability_pct
FROM classified
GROUP BY team_id;
