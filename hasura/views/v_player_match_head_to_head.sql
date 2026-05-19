CREATE OR REPLACE VIEW public.v_player_match_head_to_head AS
WITH kills AS (
  SELECT
    match_id,
    attacker_steam_id,
    attacked_steam_id,
    COUNT(*) AS kills,
    COUNT(*) FILTER (WHERE headshot) AS headshot_kills
  FROM public.player_kills
  WHERE attacker_steam_id IS NOT NULL
    AND attacker_steam_id <> attacked_steam_id
  GROUP BY match_id, attacker_steam_id, attacked_steam_id
),
damages AS (
  SELECT
    match_id,
    attacker_steam_id,
    attacked_steam_id,
    SUM(damage)::int AS damage_dealt,
    COUNT(*) AS hits
  FROM public.player_damages
  WHERE attacker_steam_id IS NOT NULL
    AND attacker_steam_id <> attacked_steam_id
  GROUP BY match_id, attacker_steam_id, attacked_steam_id
),
flashes AS (
  SELECT
    match_id,
    attacker_steam_id,
    attacked_steam_id,
    COUNT(*) AS flash_count
  FROM public.player_assists
  WHERE flash = true
    AND attacker_steam_id IS NOT NULL
  GROUP BY match_id, attacker_steam_id, attacked_steam_id
)
SELECT
  COALESCE(k.match_id, d.match_id, f.match_id) AS match_id,
  COALESCE(k.attacker_steam_id, d.attacker_steam_id, f.attacker_steam_id) AS attacker_steam_id,
  COALESCE(k.attacked_steam_id, d.attacked_steam_id, f.attacked_steam_id) AS attacked_steam_id,
  COALESCE(k.kills, 0) AS kills,
  COALESCE(k.headshot_kills, 0) AS headshot_kills,
  COALESCE(d.damage_dealt, 0) AS damage_dealt,
  COALESCE(d.hits, 0) AS hits,
  COALESCE(f.flash_count, 0) AS flash_count
FROM kills k
FULL OUTER JOIN damages d
  ON k.match_id = d.match_id
  AND k.attacker_steam_id = d.attacker_steam_id
  AND k.attacked_steam_id = d.attacked_steam_id
FULL OUTER JOIN flashes f
  ON COALESCE(k.match_id, d.match_id) = f.match_id
  AND COALESCE(k.attacker_steam_id, d.attacker_steam_id) = f.attacker_steam_id
  AND COALESCE(k.attacked_steam_id, d.attacked_steam_id) = f.attacked_steam_id;
