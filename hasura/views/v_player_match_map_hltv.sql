CREATE OR REPLACE VIEW public.v_player_match_map_hltv AS
WITH per_round AS (
  SELECT
    pmms.steam_id,
    pmms.match_id,
    pmms.match_map_id,
    r.round,
    EXISTS (
      SELECT 1 FROM public.player_kills k
      WHERE k.match_map_id = pmms.match_map_id
        AND k.round = r.round
        AND k.attacker_steam_id = pmms.steam_id
        AND k.attacked_steam_id != pmms.steam_id
    ) AS got_kill,
    EXISTS (
      SELECT 1 FROM public.player_assists a
      WHERE a.match_map_id = pmms.match_map_id
        AND a.round = r.round
        AND a.attacker_steam_id = pmms.steam_id
    ) AS got_assist,
    NOT EXISTS (
      SELECT 1 FROM public.player_kills k
      WHERE k.match_map_id = pmms.match_map_id
        AND k.round = r.round
        AND k.attacked_steam_id = pmms.steam_id
    ) AS survived,
    EXISTS (
      SELECT 1
      FROM public.player_kills k1
      JOIN public.player_kills k2
        ON k1.match_map_id = k2.match_map_id
       AND k1.round = k2.round
      WHERE k1.match_map_id = pmms.match_map_id
        AND k1.round = r.round
        AND k1.attacked_steam_id = pmms.steam_id
        AND k2.attacked_steam_id = k1.attacker_steam_id
        AND k2.attacker_steam_id != pmms.steam_id
        AND k2.time > k1.time
    ) AS traded
  FROM public.player_match_map_stats pmms
  JOIN public.match_map_rounds r
    ON r.match_map_id = pmms.match_map_id
  WHERE r.round > 0
),
kast AS (
  SELECT
    steam_id,
    match_id,
    match_map_id,
    COUNT(*)::float AS total_rounds,
    COUNT(*) FILTER (WHERE got_kill OR got_assist OR survived OR traded)::float AS kast_rounds
  FROM per_round
  GROUP BY steam_id, match_id, match_map_id
)
SELECT
  pmms.steam_id,
  pmms.match_id,
  pmms.match_map_id,
  COALESCE(NULLIF(pmms.rounds_played, 0), 0)::int AS rounds_played,
  CASE
    WHEN k.total_rounds > 0
      THEN ROUND((k.kast_rounds / k.total_rounds * 100)::numeric, 1)
    ELSE 0
  END AS kast_pct,
  CASE
    WHEN pmms.rounds_played > 0 AND k.total_rounds > 0 THEN
      ROUND(
        (
          0.0073 * (k.kast_rounds / k.total_rounds * 100)
          + 0.3591 * (pmms.kills::float / pmms.rounds_played)
          - 0.5329 * (pmms.deaths::float / pmms.rounds_played)
          + 0.2372 * (
              2.13 * (pmms.kills::float / pmms.rounds_played)
            + 0.42 * (pmms.assists::float / pmms.rounds_played)
            - 0.41
          )
          + 0.0032 * (pmms.damage::float / pmms.rounds_played)
          + 0.1587
        )::numeric, 2
      )
    ELSE NULL
  END AS hltv_rating,
  CASE
    WHEN pmms.rounds_played > 0
      THEN ROUND((pmms.kills::float / pmms.rounds_played)::numeric, 3)
    ELSE 0
  END AS kpr,
  CASE
    WHEN pmms.rounds_played > 0
      THEN ROUND((pmms.deaths::float / pmms.rounds_played)::numeric, 3)
    ELSE 0
  END AS dpr,
  CASE
    WHEN pmms.rounds_played > 0
      THEN ROUND((pmms.assists::float / pmms.rounds_played)::numeric, 3)
    ELSE 0
  END AS apr,
  CASE
    WHEN pmms.rounds_played > 0
      THEN ROUND((pmms.damage::float / pmms.rounds_played)::numeric, 1)
    ELSE 0
  END AS adr
FROM public.player_match_map_stats pmms
LEFT JOIN kast k
  ON k.steam_id = pmms.steam_id
 AND k.match_map_id = pmms.match_map_id;
