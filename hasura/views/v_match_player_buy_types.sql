CREATE OR REPLACE VIEW public.v_match_player_buy_types AS
WITH round_lineup AS (
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_1_id AS match_lineup_id,
    mmr.lineup_1_money AS own_money, mmr.lineup_2_money AS enemy_money,
    public.normalize_side(mmr.lineup_1_side) AS side
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
  UNION ALL
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_2_id,
    mmr.lineup_2_money, mmr.lineup_1_money,
    public.normalize_side(mmr.lineup_2_side)
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
),
typed AS (
  SELECT
    rl.match_id, rl.match_map_id, rl.match_lineup_id, rl.round, rl.side,
    CASE
      WHEN rl.round IN (1, 13)                THEN 'pistol'
      WHEN COALESCE(rl.own_money, 0) < 5000   THEN 'eco'
      WHEN COALESCE(rl.own_money, 0) <= 20000 THEN 'force'
      ELSE 'full'
    END AS own_buy,
    CASE
      WHEN rl.round IN (1, 13)                  THEN 'pistol'
      WHEN COALESCE(rl.enemy_money, 0) < 5000   THEN 'eco'
      WHEN COALESCE(rl.enemy_money, 0) <= 20000 THEN 'force'
      ELSE 'full'
    END AS enemy_buy
  FROM round_lineup rl
),
matchup_rounds AS (
  SELECT
    match_id, match_map_id, match_lineup_id, round, side,
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
  WHERE side IS NOT NULL
),
player_rounds AS (
  SELECT mr.match_id, mr.match_map_id, mr.match_lineup_id, mr.round, mr.side, mr.matchup,
         mlp.steam_id
  FROM matchup_rounds mr
  JOIN public.match_lineup_players mlp ON mlp.match_lineup_id = mr.match_lineup_id
  WHERE mr.matchup IS NOT NULL AND mlp.steam_id IS NOT NULL
),
kills_per_round AS (
  SELECT match_map_id, round, attacker_steam_id AS steam_id, COUNT(*)::int AS kills
  FROM public.player_kills
  WHERE attacker_steam_id IS NOT NULL
    AND attacker_team <> attacked_team
    AND attacker_steam_id <> attacked_steam_id
  GROUP BY match_map_id, round, attacker_steam_id
),
deaths_per_round AS (
  SELECT match_map_id, round, attacked_steam_id AS steam_id, COUNT(*)::int AS deaths
  FROM public.player_kills
  WHERE attacker_team <> attacked_team
    AND attacker_steam_id <> attacked_steam_id
  GROUP BY match_map_id, round, attacked_steam_id
)
SELECT
  pr.match_id,
  pr.match_map_id,
  pr.match_lineup_id,
  pr.steam_id,
  pr.side,
  pr.matchup,
  COUNT(DISTINCT pr.round)::int   AS rounds,
  COALESCE(SUM(k.kills), 0)::int  AS kills,
  COALESCE(SUM(d.deaths), 0)::int AS deaths
FROM player_rounds pr
LEFT JOIN kills_per_round k
  ON k.match_map_id = pr.match_map_id AND k.round = pr.round AND k.steam_id = pr.steam_id
LEFT JOIN deaths_per_round d
  ON d.match_map_id = pr.match_map_id AND d.round = pr.round AND d.steam_id = pr.steam_id
GROUP BY pr.match_id, pr.match_map_id, pr.match_lineup_id, pr.steam_id, pr.side, pr.matchup;
