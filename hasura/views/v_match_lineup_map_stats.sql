CREATE OR REPLACE VIEW public.v_match_lineup_map_stats AS
WITH round_lineup AS (
  SELECT
    mm.match_id,
    mmr.match_map_id,
    mmr.round,
    m.lineup_1_id AS match_lineup_id,
    mmr.lineup_1_money AS own_money,
    public.normalize_side(mmr.lineup_1_side) AS side,
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_1_side)) AS won
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
  UNION ALL
  SELECT
    mm.match_id,
    mmr.match_map_id,
    mmr.round,
    m.lineup_2_id,
    mmr.lineup_2_money,
    public.normalize_side(mmr.lineup_2_side),
    (public.normalize_side(mmr.winning_side) = public.normalize_side(mmr.lineup_2_side))
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
),
first_kill AS (
  SELECT DISTINCT ON (pk.match_map_id, pk.round)
    pk.match_map_id,
    pk.round,
    pk.attacker_steam_id,
    pk.attacked_steam_id
  FROM public.player_kills pk
  WHERE pk.attacker_team IS NOT NULL
    AND pk.attacker_team <> pk.attacked_team
    AND pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id <> pk.attacked_steam_id
  ORDER BY pk.match_map_id, pk.round, pk."time" ASC
),
fk_lineups AS (
  SELECT
    fk.match_map_id,
    fk.round,
    klp.match_lineup_id AS killer_lineup,
    vlp.match_lineup_id AS victim_lineup
  FROM first_kill fk
  JOIN public.match_maps mm ON mm.id = fk.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  LEFT JOIN public.match_lineup_players klp
    ON klp.steam_id = fk.attacker_steam_id
   AND klp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
  LEFT JOIN public.match_lineup_players vlp
    ON vlp.steam_id = fk.attacked_steam_id
   AND vlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
),
per_round AS (
  SELECT
    rl.match_id,
    rl.match_map_id,
    rl.match_lineup_id,
    rl.side,
    rl.won,
    CASE
      WHEN rl.round IN (1, 13)                THEN 'pistol'
      WHEN COALESCE(rl.own_money, 0) < 5000   THEN 'eco'
      WHEN COALESCE(rl.own_money, 0) <= 20000 THEN 'force'
      ELSE 'full'
    END                                            AS own_buy,
    (rl.round IN (1, 13))                          AS is_pistol,
    (fk.match_map_id IS NULL)                      AS no_first_kill,
    (fk.killer_lineup = rl.match_lineup_id)        AS drew_first,
    (fk.victim_lineup = rl.match_lineup_id)        AS lost_first
  FROM round_lineup rl
  LEFT JOIN fk_lineups fk
    ON fk.match_map_id = rl.match_map_id
   AND fk.round = rl.round
  WHERE rl.side IS NOT NULL
)
SELECT
  match_id,
  match_map_id,
  match_lineup_id,
  side,
  COUNT(*)::int                                                          AS rounds,
  COUNT(*) FILTER (WHERE won)::int                                       AS round_wins,
  COUNT(*) FILTER (WHERE is_pistol)::int                                 AS pistol_rounds,
  COUNT(*) FILTER (WHERE is_pistol AND won)::int                         AS pistol_wins,
  COUNT(*) FILTER (WHERE drew_first OR lost_first)::int                  AS opening_attempts,
  COUNT(*) FILTER (WHERE drew_first)::int                                AS opening_wins,
  COUNT(*) FILTER (WHERE no_first_kill OR drew_first)::int               AS man_adv_rounds,
  COUNT(*) FILTER (WHERE (no_first_kill OR drew_first) AND won)::int     AS man_adv_wins,
  COUNT(*) FILTER (WHERE lost_first)::int                                AS man_dis_rounds,
  COUNT(*) FILTER (WHERE lost_first AND won)::int                        AS man_dis_wins,
  COUNT(*) FILTER (WHERE won AND own_buy = 'pistol')::int                AS won_buy_pistol,
  COUNT(*) FILTER (WHERE won AND own_buy = 'eco')::int                   AS won_buy_eco,
  COUNT(*) FILTER (WHERE won AND own_buy = 'force')::int                 AS won_buy_force,
  COUNT(*) FILTER (WHERE won AND own_buy = 'full')::int                  AS won_buy_full
FROM per_round
GROUP BY match_id, match_map_id, match_lineup_id, side;
