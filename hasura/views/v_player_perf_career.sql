-- Career aggregation: one row per player across all maps.
DROP VIEW IF EXISTS public.player_career_stats_v CASCADE;
CREATE VIEW public.player_career_stats_v AS
WITH base AS (
  SELECT
    s.steam_id,
    COUNT(DISTINCT s.match_map_id)::int       AS maps,
    SUM(s.rounds_played)::int                 AS rounds,
    SUM(s.kills)::int                          AS kills,
    SUM(s.deaths)::int                         AS deaths,
    SUM(s.assists)::int                        AS assists,
    SUM(s.hits)::int                           AS hits,
    SUM(s.shots_fired)::int                    AS shots_fired,
    SUM(s.headshot_hits)::int                  AS headshot_hits,
    SUM(s.hs_kills)::int                        AS hs_kills,
    SUM(s.traded_death_successes)::int          AS traded_death_successes,
    SUM(s.traded_death_opportunities)::int      AS traded_death_opportunities,
    SUM(s.flash_assists)::int                  AS flash_assists,
    SUM(s.flash_duration_sum)::numeric          AS enemy_blind_duration,
    SUM(s.he_damage + s.molotov_damage)::int    AS util_damage,
    SUM(s.he_throws + s.molotov_throws)::int     AS util_thrown,
    SUM(s.hits_at_spotted)::int                 AS hits_at_spotted,
    SUM(s.shots_at_spotted)::int                AS shots_at_spotted,
    SUM(s.crosshair_angle_sum_deg)::numeric     AS crosshair_angle_sum_deg,
    SUM(s.crosshair_angle_count)::int           AS crosshair_angle_count,
    SUM(s.time_to_damage_sum_s)::numeric        AS time_to_damage_sum_s,
    SUM(s.time_to_damage_count)::int            AS time_to_damage_count,
    SUM(s.counter_strafed_shots)::int           AS counter_strafed_shots,
    SUM(s.counter_strafe_eligible_shots)::int   AS counter_strafe_eligible_shots
  FROM public.player_match_map_stats s
  GROUP BY s.steam_id
),
kast AS (
  SELECT h.steam_id,
    CASE WHEN SUM(h.rounds_played) > 0
         THEN SUM(h.kast_pct * h.rounds_played) / SUM(h.rounds_played)
         ELSE NULL END AS kast_pct
  FROM public.v_player_match_map_hltv h
  GROUP BY h.steam_id
)
SELECT
  b.steam_id,
  b.maps,
  b.rounds,
  p.premier_rank,
  -- Aim
  CASE WHEN b.shots_fired > 0 THEN 100.0 * b.hits / b.shots_fired END        AS accuracy,
  CASE WHEN b.hits > 0        THEN 100.0 * b.headshot_hits / b.hits END       AS hs_pct,
  CASE WHEN b.shots_at_spotted > 0 THEN 100.0 * b.hits_at_spotted / b.shots_at_spotted END AS accuracy_spotted,
  CASE WHEN b.crosshair_angle_count > 0 THEN b.crosshair_angle_sum_deg / b.crosshair_angle_count END AS crosshair_deg,
  CASE WHEN b.time_to_damage_count > 0 THEN b.time_to_damage_sum_s / b.time_to_damage_count END AS time_to_damage_s,
  CASE WHEN b.counter_strafe_eligible_shots > 0 THEN 100.0 * b.counter_strafed_shots / b.counter_strafe_eligible_shots END AS counter_strafe_pct,
  -- Positioning
  CASE WHEN b.rounds > 0 THEN 100.0 * (1.0 - b.deaths::numeric / b.rounds) END AS survival_pct,
  CASE WHEN b.traded_death_opportunities > 0 THEN 100.0 * b.traded_death_successes / b.traded_death_opportunities END AS traded_death_pct,
  k.kast_pct,
  -- Utility (quality, not volume)
  CASE WHEN b.rounds > 0 THEN b.flash_assists::numeric / b.rounds END          AS flash_assists_pr,
  CASE WHEN b.rounds > 0 THEN b.enemy_blind_duration / b.rounds END            AS enemy_blind_pr,
  CASE WHEN b.util_thrown > 0 THEN b.util_damage::numeric / b.util_thrown END  AS util_efficiency
FROM base b
LEFT JOIN kast k ON k.steam_id = b.steam_id
LEFT JOIN public.players p ON p.steam_id = b.steam_id;
