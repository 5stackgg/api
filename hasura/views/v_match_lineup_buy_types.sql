CREATE OR REPLACE VIEW public.v_match_lineup_buy_types AS
WITH round_lineup AS (
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_1_id AS match_lineup_id,
    mmr.lineup_1_money AS own_money,
    mmr.lineup_2_money AS enemy_money,
    public.normalize_side(mmr.lineup_1_side) AS side,
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_1_side)) AS won
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
  UNION ALL
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_2_id,
    mmr.lineup_2_money,
    mmr.lineup_1_money,
    public.normalize_side(mmr.lineup_2_side),
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_2_side))
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
),
typed AS (
  SELECT
    rl.match_id, rl.match_map_id, rl.match_lineup_id, rl.side, rl.won,
    CASE
      WHEN rl.round IN (1, 13)              THEN 'pistol'
      WHEN COALESCE(rl.own_money, 0) < 5000 THEN 'eco'
      WHEN COALESCE(rl.own_money, 0) <= 20000 THEN 'force'
      ELSE 'full'
    END AS own_buy,
    CASE
      WHEN rl.round IN (1, 13)                THEN 'pistol'
      WHEN COALESCE(rl.enemy_money, 0) < 5000 THEN 'eco'
      WHEN COALESCE(rl.enemy_money, 0) <= 20000 THEN 'force'
      ELSE 'full'
    END AS enemy_buy
  FROM round_lineup rl
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
