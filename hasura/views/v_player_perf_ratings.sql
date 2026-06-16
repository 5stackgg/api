-- Per-player Aim / Positioning / Utility ratings on a 0-100 scale (each
-- sub-metric is its cume_dist percentile within the pool of players with >= 30
-- career rounds), plus the per-rank-band goal shrunk toward 50 by sample size.
DROP VIEW IF EXISTS public.player_performance_v CASCADE;
CREATE VIEW public.player_performance_v AS
WITH pool AS (
  SELECT * FROM public.player_career_stats_v WHERE rounds >= 30
),
s_accuracy AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY accuracy)         v FROM pool WHERE accuracy IS NOT NULL),
s_hs       AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY hs_pct)           v FROM pool WHERE hs_pct IS NOT NULL),
s_spotted  AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY accuracy_spotted) v FROM pool WHERE accuracy_spotted IS NOT NULL),
s_cross    AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY crosshair_deg DESC) v FROM pool WHERE crosshair_deg IS NOT NULL),
s_ttd      AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY time_to_damage_s DESC) v FROM pool WHERE time_to_damage_s IS NOT NULL),
s_cs       AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY counter_strafe_pct) v FROM pool WHERE counter_strafe_pct IS NOT NULL),
s_surv     AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY survival_pct)      v FROM pool WHERE survival_pct IS NOT NULL),
s_traded   AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY traded_death_pct)  v FROM pool WHERE traded_death_pct IS NOT NULL),
s_kast     AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY kast_pct)          v FROM pool WHERE kast_pct IS NOT NULL),
s_fa       AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY flash_assists_pr)  v FROM pool WHERE flash_assists_pr IS NOT NULL),
s_blind    AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY enemy_blind_pr)    v FROM pool WHERE enemy_blind_pr IS NOT NULL),
s_ueff     AS (SELECT steam_id, 100.0*cume_dist() OVER (ORDER BY util_efficiency)   v FROM pool WHERE util_efficiency IS NOT NULL),
scored AS (
  SELECT
    c.steam_id, c.premier_rank, c.rounds, c.maps,
    (c.premier_rank / 5000) * 5000 AS band,
    round(s_accuracy.v) AS accuracy_score,
    round(s_hs.v)       AS hs_score,
    round(s_spotted.v)  AS spotted_score,
    round(s_cross.v)    AS crosshair_score,
    round(s_ttd.v)      AS ttd_score,
    round(s_cs.v)       AS counter_strafe_score,
    round(s_surv.v)     AS survival_score,
    round(s_traded.v)   AS traded_score,
    round(s_kast.v)     AS kast_score,
    round(s_fa.v)       AS flash_assists_score,
    round(s_blind.v)    AS blind_score,
    round(s_ueff.v)     AS util_eff_score
  FROM pool c
  LEFT JOIN s_accuracy ON s_accuracy.steam_id = c.steam_id
  LEFT JOIN s_hs       ON s_hs.steam_id       = c.steam_id
  LEFT JOIN s_spotted  ON s_spotted.steam_id  = c.steam_id
  LEFT JOIN s_cross    ON s_cross.steam_id    = c.steam_id
  LEFT JOIN s_ttd      ON s_ttd.steam_id      = c.steam_id
  LEFT JOIN s_cs       ON s_cs.steam_id       = c.steam_id
  LEFT JOIN s_surv     ON s_surv.steam_id     = c.steam_id
  LEFT JOIN s_traded   ON s_traded.steam_id   = c.steam_id
  LEFT JOIN s_kast     ON s_kast.steam_id     = c.steam_id
  LEFT JOIN s_fa       ON s_fa.steam_id       = c.steam_id
  LEFT JOIN s_blind    ON s_blind.steam_id    = c.steam_id
  LEFT JOIN s_ueff     ON s_ueff.steam_id     = c.steam_id
),
rated AS (
  SELECT s.*,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s.accuracy_score, s.hs_score, s.spotted_score,
       s.crosshair_score, s.ttd_score, s.counter_strafe_score]) x)                          AS aim_rating,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s.survival_score, s.traded_score, s.kast_score]) x) AS positioning_rating,
    (SELECT round(avg(x)) FROM unnest(ARRAY[s.flash_assists_score, s.blind_score, s.util_eff_score]) x) AS utility_rating
  FROM scored s
),
band_goal AS (
  SELECT band, count(*) AS n,
    avg(aim_rating) aim_raw, avg(positioning_rating) pos_raw, avg(utility_rating) util_raw
  FROM rated WHERE band IS NOT NULL GROUP BY band
)
SELECT
  r.steam_id, r.premier_rank, r.band, r.rounds, r.maps,
  r.aim_rating, r.positioning_rating, r.utility_rating,
  round((COALESCE(bg.n,0) * COALESCE(bg.aim_raw,50)  + 20*50) / (COALESCE(bg.n,0)+20)) AS aim_goal,
  round((COALESCE(bg.n,0) * COALESCE(bg.pos_raw,50)  + 20*50) / (COALESCE(bg.n,0)+20)) AS positioning_goal,
  round((COALESCE(bg.n,0) * COALESCE(bg.util_raw,50) + 20*50) / (COALESCE(bg.n,0)+20)) AS utility_goal,
  bg.n AS band_sample,
  r.accuracy_score, r.hs_score, r.spotted_score, r.crosshair_score, r.ttd_score, r.counter_strafe_score,
  r.survival_score, r.traded_score, r.kast_score,
  r.flash_assists_score, r.blind_score, r.util_eff_score
FROM rated r
LEFT JOIN band_goal bg ON bg.band = r.band;
