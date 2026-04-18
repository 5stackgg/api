CREATE OR REPLACE VIEW public.v_tournament_player_stats AS
WITH t_matches AS (
    SELECT DISTINCT
        ts.tournament_id,
        tb.match_id
    FROM tournament_brackets tb
    JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
    WHERE tb.match_id IS NOT NULL
),
kills_agg AS (
    SELECT
        tm.tournament_id,
        pk.attacker_steam_id AS steam_id,
        COUNT(*)::int AS kills,
        COUNT(*) FILTER (WHERE pk.headshot)::int AS headshots
    FROM t_matches tm
    JOIN player_kills pk ON pk.match_id = tm.match_id
    WHERE pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id != pk.attacked_steam_id
    GROUP BY tm.tournament_id, pk.attacker_steam_id
),
deaths_agg AS (
    SELECT
        tm.tournament_id,
        pk.attacked_steam_id AS steam_id,
        COUNT(*)::int AS deaths
    FROM t_matches tm
    JOIN player_kills pk ON pk.match_id = tm.match_id
    WHERE pk.attacked_steam_id IS NOT NULL
      AND pk.attacker_steam_id IS NOT NULL
      AND pk.attacker_steam_id != pk.attacked_steam_id
    GROUP BY tm.tournament_id, pk.attacked_steam_id
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
    COALESCE(k.kills, 0) AS kills,
    COALESCE(k.headshots, 0) AS headshots,
    COALESCE(d.deaths, 0) AS deaths,
    COALESCE(a.assists, 0) AS assists,
    m.matches_played,
    CASE WHEN COALESCE(d.deaths, 0) = 0
         THEN COALESCE(k.kills, 0)::float
         ELSE ROUND(COALESCE(k.kills, 0)::numeric / d.deaths::numeric, 2)::float
    END AS kdr,
    CASE WHEN COALESCE(k.kills, 0) = 0
         THEN 0::float
         ELSE ROUND(COALESCE(k.headshots, 0)::numeric / k.kills::numeric * 100, 1)::float
    END AS headshot_percentage
FROM matches_agg m
LEFT JOIN kills_agg k
  ON k.tournament_id = m.tournament_id AND k.steam_id = m.steam_id
LEFT JOIN deaths_agg d
  ON d.tournament_id = m.tournament_id AND d.steam_id = m.steam_id
LEFT JOIN assists_agg a
  ON a.tournament_id = m.tournament_id AND a.steam_id = m.steam_id;
