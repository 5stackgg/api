-- Per (player, map) HLTV 2.0 rating + KAST, read from stored columns.
CREATE OR REPLACE VIEW public.v_player_match_map_hltv AS
SELECT
  pmms.steam_id,
  pmms.match_id,
  pmms.match_map_id,
  COALESCE(NULLIF(pmms.rounds_played, 0), 0)::int AS rounds_played,
  CASE
    WHEN pmms.kast_total_rounds > 0
      THEN ROUND((pmms.kast_rounds::float / pmms.kast_total_rounds * 100)::numeric, 1)
    ELSE 0
  END AS kast_pct,
  CASE
    WHEN pmms.rounds_played > 0 AND pmms.kast_total_rounds > 0 THEN
      ROUND(
        (
          0.0073 * (pmms.kast_rounds::float / pmms.kast_total_rounds * 100)
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
FROM public.player_match_map_stats pmms;
