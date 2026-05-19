CREATE OR REPLACE VIEW public.v_tournament_player_stats AS
WITH t_matches AS (
    SELECT DISTINCT
        ts.tournament_id,
        tb.match_id
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.match_id IS NOT NULL
),
-- Kills, deaths and headshots come from the same player_kills rows. Unpivot
-- each kill into one row per side via LATERAL VALUES so player_kills is
-- scanned (and the chunk indexes hit) once instead of twice, then aggregate
-- both sides together keyed by player.
kd_agg AS (
    SELECT
        tm.tournament_id,
        e.steam_id,
        SUM(e.kill_flag)::int AS kills,
        SUM(e.death_flag)::int AS deaths,
        SUM(e.headshot_flag)::int AS headshots
    FROM t_matches tm
    JOIN player_kills pk
      ON pk.match_id = tm.match_id
     AND pk.attacker_steam_id IS NOT NULL
     AND pk.attacker_steam_id != pk.attacked_steam_id
    CROSS JOIN LATERAL (VALUES
        (pk.attacker_steam_id, 1, 0, CASE WHEN pk.headshot THEN 1 ELSE 0 END),
        (pk.attacked_steam_id, 0, 1, 0)
    ) AS e(steam_id, kill_flag, death_flag, headshot_flag)
    WHERE e.steam_id IS NOT NULL
    GROUP BY tm.tournament_id, e.steam_id
),
assists_agg AS (
    SELECT
        tm.tournament_id,
        pa.attacker_steam_id AS steam_id,
        COUNT(*)::int AS assists
    FROM t_matches tm
    JOIN player_assists pa ON pa.match_id = tm.match_id
    WHERE pa.attacker_steam_id IS NOT NULL
    GROUP BY tm.tournament_id, pa.attacker_steam_id
),
matches_agg AS (
    SELECT
        tm.tournament_id,
        mlp.steam_id,
        COUNT(DISTINCT tm.match_id)::int AS matches_played
    FROM t_matches tm
    JOIN matches m ON m.id = tm.match_id
    JOIN match_lineup_players mlp
      ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
    WHERE mlp.steam_id IS NOT NULL
    GROUP BY tm.tournament_id, mlp.steam_id
)
SELECT
    m.tournament_id,
    m.steam_id AS player_steam_id,
    COALESCE(kd.kills, 0) AS kills,
    COALESCE(kd.headshots, 0) AS headshots,
    COALESCE(kd.deaths, 0) AS deaths,
    COALESCE(a.assists, 0) AS assists,
    m.matches_played,
    CASE WHEN COALESCE(kd.deaths, 0) = 0
         THEN COALESCE(kd.kills, 0)::float
         ELSE ROUND(COALESCE(kd.kills, 0)::numeric / kd.deaths::numeric, 2)::float
    END AS kdr,
    CASE WHEN COALESCE(kd.kills, 0) = 0
         THEN 0::float
         ELSE ROUND(COALESCE(kd.headshots, 0)::numeric / kd.kills::numeric * 100, 1)::float
    END AS headshot_percentage
FROM matches_agg m
LEFT JOIN kd_agg kd
  ON kd.tournament_id = m.tournament_id AND kd.steam_id = m.steam_id
LEFT JOIN assists_agg a
  ON a.tournament_id = m.tournament_id AND a.steam_id = m.steam_id;
