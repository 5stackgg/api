-- Every match page filters on match_id. A filter only passes below a window
-- function, a DISTINCT ON or a GROUP BY on one of its keys, so match_id is in
-- each of them even though match_map_id already implies it; without it every
-- page read computed the view for every match on the panel.
CREATE OR REPLACE VIEW public.v_match_lineup_map_stats AS
WITH round_lineup AS (
  SELECT
    mm.match_id,
    mmr.match_map_id,
    mmr.round,
    m.lineup_1_id AS match_lineup_id,
    mmr.lineup_1_money AS own_money,
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
    mm.match_id,
    mmr.match_map_id,
    mmr.round,
    m.lineup_2_id,
    mmr.lineup_2_money,
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
    (rl.match_type IS DISTINCT FROM 'Rush' AND rl.round > rl.mr * 2
      AND (rl.round - rl.mr * 2 - 1) % 3 = 0) AS ot_half_start
  FROM round_lineup rl
  WINDOW w AS (PARTITION BY rl.match_id, rl.match_map_id, rl.match_lineup_id ORDER BY rl.round)
),
first_kill AS (
  SELECT DISTINCT ON (pk.match_id, pk.match_map_id, pk.round)
    pk.match_id,
    pk.match_map_id,
    pk.round,
    pk.attacker_steam_id,
    pk.attacked_steam_id
  FROM public.player_kills pk
  WHERE pk.attacker_team IS NOT NULL
    AND pk.attacker_team <> pk.attacked_team
    AND pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id <> pk.attacked_steam_id
  ORDER BY pk.match_id, pk.match_map_id, pk.round, pk."time" ASC
),
fk_lineups AS (
  SELECT
    fk.match_id,
    fk.match_map_id,
    fk.round,
    klp.match_lineup_id AS killer_lineup,
    vlp.match_lineup_id AS victim_lineup
  FROM first_kill fk
  JOIN public.match_maps mm ON mm.id = fk.match_map_id AND mm.match_id = fk.match_id
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
      WHEN rl.is_pistol          THEN 'pistol'
      WHEN rl.ot_half_start      THEN CASE WHEN rl.match_type IN ('Competitive', 'Premier', 'Faceit') THEN 'full' END
      WHEN rl.own_start < 5000   THEN 'eco'
      WHEN rl.own_start <= 20000 THEN 'force'
      WHEN rl.own_start > 20000  THEN 'full'
    END                                            AS own_buy,
    rl.is_pistol                                   AS is_pistol,
    (fk.match_map_id IS NULL)                      AS no_first_kill,
    (fk.killer_lineup = rl.match_lineup_id)        AS drew_first,
    (fk.victim_lineup = rl.match_lineup_id)        AS lost_first
  FROM round_start rl
  LEFT JOIN fk_lineups fk
    ON fk.match_id = rl.match_id
   AND fk.match_map_id = rl.match_map_id
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
