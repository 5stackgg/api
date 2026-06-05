-- Per-player opening-duel record, so the Opening Duels tab reads aggregates
-- instead of scanning each round's kills. Grain: (match_map, lineup, player,
-- side). `attempts` = first inter-team kill of the round involving the player
-- (as killer or victim); `wins` = player drew first blood; `deaths` = player
-- was the opening victim; `traded_deaths` = that opening death was traded by a
-- teammate within the round. The attempt% denominator (lineup total rounds)
-- comes from v_match_lineup_map_stats on the consumer side.
CREATE OR REPLACE VIEW public.v_match_player_opening_duels AS
WITH round_sides AS (
  SELECT
    mm.match_id, mmr.match_map_id, mmr.round,
    m.lineup_1_id AS l1, public.normalize_side(mmr.lineup_1_side) AS l1_side,
    m.lineup_2_id AS l2, public.normalize_side(mmr.lineup_2_side) AS l2_side
  FROM public.match_map_rounds mmr
  JOIN public.match_maps mm ON mm.id = mmr.match_map_id
  JOIN public.matches m ON m.id = mm.match_id
  WHERE mmr.round > 0 AND mmr.deleted_at IS NULL
),
first_kill AS (
  SELECT DISTINCT ON (pk.match_map_id, pk.round)
    pk.match_map_id, pk.round, pk."time",
    pk.attacker_steam_id AS killer, pk.attacked_steam_id AS victim
  FROM public.player_kills pk
  WHERE pk.attacker_team IS NOT NULL
    AND pk.attacker_team <> pk.attacked_team
    AND pk.attacker_steam_id IS NOT NULL
    AND pk.attacker_steam_id <> pk.attacked_steam_id
  ORDER BY pk.match_map_id, pk.round, pk."time" ASC
),
fk AS (
  SELECT
    fk.match_map_id, fk.round, fk.killer, fk.victim,
    EXISTS (
      SELECT 1 FROM public.player_kills t
      WHERE t.match_map_id = fk.match_map_id
        AND t.round = fk.round
        AND t.attacked_steam_id = fk.killer
        AND t.attacker_steam_id <> fk.victim
        AND t."time" > fk."time"
    ) AS victim_traded
  FROM first_kill fk
),
duel_rows AS (
  -- killer perspective (won the opening)
  SELECT rs.match_id, fk.match_map_id, fk.round, klp.match_lineup_id,
    CASE WHEN klp.match_lineup_id = rs.l1 THEN rs.l1_side ELSE rs.l2_side END AS side,
    fk.killer AS steam_id, true AS is_win, false AS is_death, false AS traded
  FROM fk
  JOIN round_sides rs ON rs.match_map_id = fk.match_map_id AND rs.round = fk.round
  JOIN public.match_lineup_players klp
    ON klp.steam_id = fk.killer AND klp.match_lineup_id IN (rs.l1, rs.l2)
  UNION ALL
  -- victim perspective (lost the opening)
  SELECT rs.match_id, fk.match_map_id, fk.round, vlp.match_lineup_id,
    CASE WHEN vlp.match_lineup_id = rs.l1 THEN rs.l1_side ELSE rs.l2_side END,
    fk.victim, false, true, fk.victim_traded
  FROM fk
  JOIN round_sides rs ON rs.match_map_id = fk.match_map_id AND rs.round = fk.round
  JOIN public.match_lineup_players vlp
    ON vlp.steam_id = fk.victim AND vlp.match_lineup_id IN (rs.l1, rs.l2)
),
agg AS (
  SELECT
    match_id, match_map_id, match_lineup_id, steam_id, side,
    COUNT(*)::int                                  AS attempts,
    COUNT(*) FILTER (WHERE is_win)::int            AS wins,
    COUNT(*) FILTER (WHERE is_death)::int          AS deaths,
    COUNT(*) FILTER (WHERE is_death AND traded)::int AS traded_deaths
  FROM duel_rows
  WHERE side IS NOT NULL
  GROUP BY match_id, match_map_id, match_lineup_id, steam_id, side
)
SELECT
  match_id,
  match_map_id,
  match_lineup_id,
  steam_id,
  side,
  attempts,
  wins,
  deaths,
  traded_deaths
FROM agg;
