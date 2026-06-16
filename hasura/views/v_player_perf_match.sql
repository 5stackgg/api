-- Per-match performance: one row per (player, match) with Aim / Positioning /
-- Utility + overall 0-100 scores plus the raw per-match value of each stat.
-- The cume_dist ranking spans every player-match, but that pool is small and
-- the per-match KAST is now a stored column, so this stays a regular view.
DROP VIEW IF EXISTS public.player_match_performance_v CASCADE;
CREATE VIEW public.player_match_performance_v AS
WITH per_match AS (
  SELECT
    s.steam_id, s.match_id,
    SUM(s.rounds_played)::int AS rounds,
    SUM(s.hits) hits, SUM(s.shots_fired) shots, SUM(s.headshot_hits) hs_hits,
    SUM(s.hits_at_spotted) h_spot, SUM(s.shots_at_spotted) s_spot,
    SUM(s.counter_strafed_shots) cs_stopped, SUM(s.counter_strafe_eligible_shots) cs_elig,
    SUM(s.deaths) deaths,
    SUM(s.traded_death_successes) traded, SUM(s.traded_death_opportunities) traded_opp,
    SUM(s.flash_assists) flash_assists, SUM(s.flash_duration_sum)::numeric blind,
    SUM(s.he_damage + s.molotov_damage) util_dmg, SUM(s.he_throws + s.molotov_throws) util_thrown
  FROM public.player_match_map_stats s
  GROUP BY s.steam_id, s.match_id
  HAVING SUM(s.rounds_played) >= 10
),
kast AS (
  SELECT steam_id, match_id,
    CASE WHEN SUM(rounds_played) > 0 THEN SUM(kast_pct*rounds_played)/SUM(rounds_played) END AS kast_pct
  FROM public.v_player_match_map_hltv GROUP BY steam_id, match_id
),
rates AS (
  SELECT pm.steam_id, pm.match_id, pm.rounds,
    CASE WHEN pm.shots > 0 THEN 100.0*pm.hits/pm.shots END           AS accuracy,
    CASE WHEN pm.hits > 0 THEN 100.0*pm.hs_hits/pm.hits END          AS hs_pct,
    CASE WHEN pm.s_spot > 0 THEN 100.0*pm.h_spot/pm.s_spot END       AS accuracy_spotted,
    CASE WHEN pm.cs_elig > 0 THEN 100.0*pm.cs_stopped/pm.cs_elig END AS counter_strafe_pct,
    CASE WHEN pm.rounds > 0 THEN 100.0*(1.0-pm.deaths::numeric/pm.rounds) END AS survival_pct,
    CASE WHEN pm.traded_opp > 0 THEN 100.0*pm.traded/pm.traded_opp END AS traded_death_pct,
    k.kast_pct,
    CASE WHEN pm.rounds > 0 THEN pm.flash_assists::numeric/pm.rounds END AS flash_assists_pr,
    CASE WHEN pm.rounds > 0 THEN pm.blind/pm.rounds END             AS enemy_blind_pr,
    CASE WHEN pm.util_thrown > 0 THEN pm.util_dmg::numeric/pm.util_thrown END AS util_efficiency
  FROM per_match pm LEFT JOIN kast k ON k.steam_id=pm.steam_id AND k.match_id=pm.match_id
),
s_acc   AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY accuracy)         v FROM rates WHERE accuracy IS NOT NULL),
s_hs    AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY hs_pct)           v FROM rates WHERE hs_pct IS NOT NULL),
s_surv  AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY survival_pct)     v FROM rates WHERE survival_pct IS NOT NULL),
s_trade AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY traded_death_pct) v FROM rates WHERE traded_death_pct IS NOT NULL),
s_kast  AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY kast_pct)         v FROM rates WHERE kast_pct IS NOT NULL),
s_fa    AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY flash_assists_pr) v FROM rates WHERE flash_assists_pr IS NOT NULL),
s_blind AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY enemy_blind_pr)   v FROM rates WHERE enemy_blind_pr IS NOT NULL),
s_ueff  AS (SELECT steam_id, match_id, 100.0*cume_dist() OVER (ORDER BY util_efficiency)  v FROM rates WHERE util_efficiency IS NOT NULL),
scored AS (
  SELECT r.steam_id, r.match_id, r.rounds,
    r.accuracy, r.hs_pct, r.accuracy_spotted, r.counter_strafe_pct,
    r.survival_pct, r.traded_death_pct, r.kast_pct,
    r.flash_assists_pr, r.enemy_blind_pr, r.util_efficiency,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s_acc.v, s_hs.v]) x)                       AS aim_rating,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s_surv.v, s_trade.v, s_kast.v]) x)         AS positioning_rating,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s_fa.v, s_blind.v, s_ueff.v]) x)           AS utility_rating
  FROM rates r
  LEFT JOIN s_acc   ON s_acc.steam_id=r.steam_id   AND s_acc.match_id=r.match_id
  LEFT JOIN s_hs    ON s_hs.steam_id=r.steam_id    AND s_hs.match_id=r.match_id
  LEFT JOIN s_surv  ON s_surv.steam_id=r.steam_id  AND s_surv.match_id=r.match_id
  LEFT JOIN s_trade ON s_trade.steam_id=r.steam_id AND s_trade.match_id=r.match_id
  LEFT JOIN s_kast  ON s_kast.steam_id=r.steam_id  AND s_kast.match_id=r.match_id
  LEFT JOIN s_fa    ON s_fa.steam_id=r.steam_id    AND s_fa.match_id=r.match_id
  LEFT JOIN s_blind ON s_blind.steam_id=r.steam_id AND s_blind.match_id=r.match_id
  LEFT JOIN s_ueff  ON s_ueff.steam_id=r.steam_id  AND s_ueff.match_id=r.match_id
)
SELECT
  sc.steam_id, sc.match_id, sc.rounds,
  COALESCE(m.ended_at, m.started_at, m.created_at) AS played_at,
  m.source,
  sc.aim_rating, sc.positioning_rating, sc.utility_rating,
  (SELECT round(avg(x)) FROM unnest(ARRAY[sc.aim_rating, sc.positioning_rating, sc.utility_rating]) x) AS overall_rating,
  round(sc.accuracy, 1)           AS accuracy,
  round(sc.hs_pct, 1)             AS hs_pct,
  round(sc.accuracy_spotted, 1)   AS accuracy_spotted,
  round(sc.counter_strafe_pct, 1) AS counter_strafe_pct,
  round(sc.survival_pct, 1)       AS survival_pct,
  round(sc.traded_death_pct, 1)   AS traded_death_pct,
  round(sc.kast_pct, 1)           AS kast_pct,
  round(sc.flash_assists_pr, 2)   AS flash_assists_pr,
  round(sc.enemy_blind_pr, 2)     AS enemy_blind_pr,
  round(sc.util_efficiency, 1)    AS util_efficiency
FROM scored sc
JOIN public.matches m ON m.id = sc.match_id;
