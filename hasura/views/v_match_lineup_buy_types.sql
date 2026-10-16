-- Every match page filters on match_id. A filter only passes below a window
-- function, a DISTINCT ON or a GROUP BY on one of its keys, so match_id is in
-- each of them even though match_map_id already implies it; without it every
-- page read computed the view for every match on the panel.
CREATE OR REPLACE VIEW public.v_match_lineup_buy_types AS
WITH round_lineup AS (
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_1_id AS match_lineup_id,
    mmr.lineup_1_money AS own_money,
    mmr.lineup_2_money AS enemy_money,
    public.normalize_side(mmr.lineup_1_side) AS side,
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_1_side)) AS won,
    (mmr.round = 1 OR (mo.type IS DISTINCT FROM 'Rush' AND mmr.round = COALESCE(mo.mr, 12) + 1)) AS is_pistol,
    mo.type AS match_type,
    COALESCE(mo.mr, 12) AS mr
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  LEFT JOIN public.match_options mo ON mo.id = m.match_options_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
  UNION ALL
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_2_id,
    mmr.lineup_2_money,
    mmr.lineup_1_money,
    public.normalize_side(mmr.lineup_2_side),
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_2_side)),
    (mmr.round = 1 OR (mo.type IS DISTINCT FROM 'Rush' AND mmr.round = COALESCE(mo.mr, 12) + 1)),
    mo.type,
    COALESCE(mo.mr, 12)
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  LEFT JOIN public.match_options mo ON mo.id = m.match_options_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
),
-- Money is stored as each round ends, so a round starts on the previous
-- round's figure while the lineup stays on that side. Each overtime half
-- restarts every player on mp_overtime_startmoney, which 5Stack never sets;
-- whatever the game gives, a five-player side clears the full-buy line.
round_start AS (
  SELECT
    rl.*,
    CASE WHEN LAG(rl.round) OVER w = rl.round - 1 AND LAG(rl.side) OVER w = rl.side
      THEN LAG(rl.own_money) OVER w END AS own_start,
    CASE WHEN LAG(rl.round) OVER w = rl.round - 1 AND LAG(rl.side) OVER w = rl.side
      THEN LAG(rl.enemy_money) OVER w END AS enemy_start,
    (rl.match_type IS DISTINCT FROM 'Rush' AND rl.round > rl.mr * 2
      AND (rl.round - rl.mr * 2 - 1) % 3 = 0) AS ot_half_start
  FROM round_lineup rl
  WINDOW w AS (PARTITION BY rl.match_id, rl.match_map_id, rl.match_lineup_id ORDER BY rl.round)
),
typed AS (
  SELECT
    rs.match_id, rs.match_map_id, rs.match_lineup_id, rs.side, rs.won,
    CASE
      WHEN rs.is_pistol            THEN 'pistol'
      WHEN rs.ot_half_start        THEN CASE WHEN rs.match_type IN ('Competitive', 'Premier', 'Faceit') THEN 'full' END
      WHEN rs.own_start < 5000     THEN 'eco'
      WHEN rs.own_start <= 20000   THEN 'force'
      WHEN rs.own_start > 20000    THEN 'full'
    END AS own_buy,
    CASE
      WHEN rs.is_pistol            THEN 'pistol'
      WHEN rs.ot_half_start        THEN CASE WHEN rs.match_type IN ('Competitive', 'Premier', 'Faceit') THEN 'full' END
      WHEN rs.enemy_start < 5000   THEN 'eco'
      WHEN rs.enemy_start <= 20000 THEN 'force'
      WHEN rs.enemy_start > 20000  THEN 'full'
    END AS enemy_buy
  FROM round_start rs
),
classified AS (
  SELECT
    match_id, match_map_id, match_lineup_id, side, won,
    CASE
      WHEN own_buy = 'pistol' AND enemy_buy = 'pistol' THEN 'pistol_v_pistol'
      WHEN own_buy = 'full'   AND enemy_buy = 'full'   THEN 'full_v_full'
      WHEN own_buy = 'full'   AND enemy_buy = 'eco'    THEN 'full_v_eco'
      WHEN own_buy = 'full'   AND enemy_buy = 'force'  THEN 'full_v_force'
      WHEN own_buy = 'eco'    AND enemy_buy = 'full'   THEN 'eco_v_full'
      WHEN own_buy = 'force'  AND enemy_buy = 'full'   THEN 'force_v_full'
      ELSE NULL
    END AS matchup
  FROM typed
)
SELECT
  match_id,
  match_map_id,
  match_lineup_id,
  side,
  matchup,
  COUNT(*)::int                   AS rounds,
  COUNT(*) FILTER (WHERE won)::int AS wins
FROM classified
WHERE matchup IS NOT NULL AND side IS NOT NULL
GROUP BY match_id, match_map_id, match_lineup_id, side, matchup;
