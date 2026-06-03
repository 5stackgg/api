-- Per-player, per-match performance for BOTH native 5Stack matches and
-- imported external (Valve/FACEIT) matches. v_player_elo only exists for
-- 5Stack matches, so this view is the source-agnostic basis for win-rate and
-- K/D: it carries the match source, type and timestamp alongside summed
-- kills/deaths/assists and a per-match win/loss derived from map winners.
CREATE OR REPLACE VIEW public.v_player_match_performance AS
SELECT
    mlp.steam_id                               AS player_steam_id,
    m.id                                       AS match_id,
    m.source                                   AS source,
    m.created_at                               AS match_created_at,
    mo.type                                    AS type,
    COALESCE(s.kills, 0)::integer              AS kills,
    COALESCE(s.deaths, 0)::integer             AS deaths,
    COALESCE(s.assists, 0)::integer            AS assists,
    CASE
        WHEN w.won > w.lost THEN 'win'
        WHEN w.won < w.lost THEN 'loss'
        ELSE 'tie'
    END                                        AS match_result
FROM match_lineup_players mlp
    INNER JOIN match_lineups ml ON ml.id = mlp.match_lineup_id
    INNER JOIN matches m        ON m.id = ml.match_id
    LEFT JOIN match_options mo  ON mo.id = m.match_options_id
    LEFT JOIN LATERAL (
        SELECT
            SUM(pms.kills)   AS kills,
            SUM(pms.deaths)  AS deaths,
            SUM(pms.assists) AS assists
        FROM player_match_map_stats pms
        WHERE pms.match_id = m.id
          AND pms.steam_id = mlp.steam_id
    ) s ON true
    INNER JOIN LATERAL (
        SELECT
            COUNT(*) FILTER (WHERE mm.winning_lineup_id = ml.id) AS won,
            COUNT(*) FILTER (
                WHERE mm.winning_lineup_id IS NOT NULL
                  AND mm.winning_lineup_id <> ml.id
            ) AS lost
        FROM match_maps mm
        WHERE mm.match_id = m.id
          AND mm.status = 'Finished'
    ) w ON true
WHERE (w.won + w.lost) > 0;
