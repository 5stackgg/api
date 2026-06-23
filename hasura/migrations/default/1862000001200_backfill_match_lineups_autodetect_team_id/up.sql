-- Backfill match_lineups.team_id for Competitive matches a team played together
-- but never had the team explicitly selected. Mirrors the runtime rule in
-- MatchImportService.detectTeamForLineup / assignDetectedTeams:
--   * Competitive matches only
--   * a lineup belongs to a team when >= scrim_team_autodetect_min_overlap
--     (default 4) of its members are on that team's roster (roster size ignored)
--   * highest overlap wins; ties break to the lowest team_id (teams have no
--     created_at to order by age)
--   * only fills lineups where team_id IS NULL (never overwrites a selection)
--   * if both lineups of a match detect the same team, keep the higher overlap

WITH params AS (
  SELECT COALESCE(
    NULLIF((SELECT value FROM settings WHERE name = 'scrim_team_autodetect_min_overlap'), '')::int,
    4
  ) AS min_overlap
),
candidate_lineups AS (
  SELECT
    ml.id AS lineup_id,
    m.id  AS match_id,
    (ml.id = m.lineup_1_id) AS is_lineup_1
  FROM match_lineups ml
  JOIN matches m ON ml.id IN (m.lineup_1_id, m.lineup_2_id)
  JOIN match_options mo ON mo.id = m.match_options_id
  WHERE ml.team_id IS NULL
    AND mo.type = 'Competitive'
    -- Skip PickingPlayers: assigning team_id fires tau_match_lineups, which
    -- would wipe and repopulate the lineup from the team roster.
    AND m.status <> 'PickingPlayers'
),
members AS (
  SELECT cl.lineup_id, cl.match_id, cl.is_lineup_1, mlp.steam_id
  FROM candidate_lineups cl
  JOIN match_lineup_players mlp ON mlp.match_lineup_id = cl.lineup_id
  WHERE mlp.steam_id IS NOT NULL
),
team_overlaps AS (
  SELECT m.lineup_id, m.match_id, m.is_lineup_1, tr.team_id, count(*) AS overlap
  FROM members m
  JOIN team_roster tr ON tr.player_steam_id = m.steam_id
  GROUP BY m.lineup_id, m.match_id, m.is_lineup_1, tr.team_id
),
ranked AS (
  SELECT
    o.*,
    ROW_NUMBER() OVER (PARTITION BY o.lineup_id ORDER BY o.overlap DESC, o.team_id ASC) AS rn
  FROM team_overlaps o
  CROSS JOIN params p
  WHERE o.overlap >= p.min_overlap
),
winners AS (
  SELECT lineup_id, match_id, is_lineup_1, team_id, overlap
  FROM ranked
  WHERE rn = 1
),
deduped AS (
  SELECT
    lineup_id,
    team_id,
    ROW_NUMBER() OVER (
      PARTITION BY match_id, team_id
      ORDER BY overlap DESC, is_lineup_1 DESC
    ) AS team_rn
  FROM winners
)
UPDATE match_lineups ml
   SET team_id = d.team_id
  FROM deduped d
 WHERE ml.id = d.lineup_id
   AND d.team_rn = 1
   AND ml.team_id IS NULL;
