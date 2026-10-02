-- Season split of player_career_stats_v + player_performance_v: the same 0-100
-- sub-scores, each a cume_dist percentile within that season's pool of players
-- with >= 30 rounds in it. A match belongs to the season its end time falls in.
DROP VIEW IF EXISTS public.player_season_performance_v;
CREATE VIEW public.player_season_performance_v AS
WITH base AS (
  SELECT
    s.steam_id,
    se.id                                       AS season_id,
    se.starts_at                                AS season_starts_at,
    SUM(s.rounds_played)::int                   AS rounds,
    SUM(s.deaths)::int                          AS deaths,
    SUM(s.hits)::int                            AS hits,
    SUM(s.shots_fired)::int                     AS shots_fired,
    SUM(s.headshot_hits)::int                   AS headshot_hits,
    SUM(s.traded_death_successes)::int          AS traded_death_successes,
    SUM(s.traded_death_opportunities)::int      AS traded_death_opportunities,
    SUM(s.flash_assists)::int                   AS flash_assists,
    SUM(s.flash_duration_sum)::numeric          AS enemy_blind_duration,
    SUM(s.he_damage + s.molotov_damage)::int    AS util_damage,
    SUM(s.he_throws + s.molotov_throws)::int    AS util_thrown,
    SUM(s.hits_at_spotted)::int                 AS hits_at_spotted,
    SUM(s.shots_at_spotted)::int                AS shots_at_spotted,
    SUM(s.crosshair_angle_sum_deg)::numeric     AS crosshair_angle_sum_deg,
    SUM(s.crosshair_angle_count)::int           AS crosshair_angle_count,
    SUM(s.time_to_damage_sum_s)::numeric        AS time_to_damage_sum_s,
    SUM(s.time_to_damage_count)::int            AS time_to_damage_count,
    SUM(s.counter_strafed_shots)::int           AS counter_strafed_shots,
    SUM(s.counter_strafe_eligible_shots)::int   AS counter_strafe_eligible_shots,
    SUM(s.kast_rounds)::int                     AS kast_rounds,
    SUM(s.kast_total_rounds)::int               AS kast_total_rounds
  FROM public.player_match_map_stats s
  JOIN public.matches m ON m.id = s.match_id
  JOIN public.seasons se
    ON m.ended_at >= se.starts_at
   AND (se.ends_at IS NULL OR m.ended_at < se.ends_at)
  GROUP BY s.steam_id, se.id, se.starts_at
),
pool AS (
  SELECT
    b.steam_id, b.season_id, b.season_starts_at, b.rounds,
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
    CASE WHEN b.kast_total_rounds > 0 THEN 100.0 * b.kast_rounds / b.kast_total_rounds END AS kast_pct,
    -- Utility (quality, not volume)
    CASE WHEN b.rounds > 0 THEN b.flash_assists::numeric / b.rounds END          AS flash_assists_pr,
    CASE WHEN b.rounds > 0 THEN b.enemy_blind_duration / b.rounds END            AS enemy_blind_pr,
    CASE WHEN b.util_thrown > 0 THEN b.util_damage::numeric / b.util_thrown END  AS util_efficiency
  FROM base b
  WHERE b.rounds >= 30
),
-- Partitioning on IS NULL ranks each metric only among the players who have
-- it, like the per-metric CTEs in player_performance_v.
scored AS (
  SELECT
    p.steam_id, p.season_id, p.season_starts_at, p.rounds,
    CASE WHEN p.accuracy IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.accuracy IS NULL ORDER BY p.accuracy)) END AS accuracy_score,
    CASE WHEN p.hs_pct IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.hs_pct IS NULL ORDER BY p.hs_pct)) END AS hs_score,
    CASE WHEN p.accuracy_spotted IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.accuracy_spotted IS NULL ORDER BY p.accuracy_spotted)) END AS spotted_score,
    CASE WHEN p.crosshair_deg IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.crosshair_deg IS NULL ORDER BY p.crosshair_deg DESC)) END AS crosshair_score,
    CASE WHEN p.time_to_damage_s IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.time_to_damage_s IS NULL ORDER BY p.time_to_damage_s DESC)) END AS ttd_score,
    CASE WHEN p.counter_strafe_pct IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.counter_strafe_pct IS NULL ORDER BY p.counter_strafe_pct)) END AS counter_strafe_score,
    CASE WHEN p.survival_pct IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.survival_pct IS NULL ORDER BY p.survival_pct)) END AS survival_score,
    CASE WHEN p.traded_death_pct IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.traded_death_pct IS NULL ORDER BY p.traded_death_pct)) END AS traded_score,
    CASE WHEN p.kast_pct IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.kast_pct IS NULL ORDER BY p.kast_pct)) END AS kast_score,
    CASE WHEN p.flash_assists_pr IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.flash_assists_pr IS NULL ORDER BY p.flash_assists_pr)) END AS flash_assists_score,
    CASE WHEN p.enemy_blind_pr IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.enemy_blind_pr IS NULL ORDER BY p.enemy_blind_pr)) END AS blind_score,
    CASE WHEN p.util_efficiency IS NOT NULL THEN round(100.0 * cume_dist() OVER (PARTITION BY p.season_id, p.util_efficiency IS NULL ORDER BY p.util_efficiency)) END AS util_eff_score
  FROM pool p
)
SELECT
  s.steam_id, s.season_id, s.season_starts_at, s.rounds,
  (SELECT round(avg(x)) FROM unnest(ARRAY[s.accuracy_score, s.hs_score, s.spotted_score,
     s.crosshair_score, s.ttd_score, s.counter_strafe_score]) x)                          AS aim_rating,
  (SELECT round(avg(x)) FROM unnest(ARRAY[s.survival_score, s.traded_score, s.kast_score]) x) AS positioning_rating,
  (SELECT round(avg(x)) FROM unnest(ARRAY[s.flash_assists_score, s.blind_score, s.util_eff_score]) x) AS utility_rating,
  s.accuracy_score, s.hs_score, s.spotted_score, s.crosshair_score, s.ttd_score, s.counter_strafe_score,
  s.survival_score, s.traded_score, s.kast_score,
  s.flash_assists_score, s.blind_score, s.util_eff_score
FROM scored s;
