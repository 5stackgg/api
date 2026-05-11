-- All-maps rollup of player_match_map_stats. One row per (steam_id, match_id).

CREATE OR REPLACE VIEW public.player_match_stats_v AS
SELECT
  s.steam_id,
  s.match_id,
  SUM(s.kills)::integer                AS kills,
  SUM(s.hs_kills)::integer             AS hs_kills,
  SUM(s.knife_kills)::integer          AS knife_kills,
  SUM(s.zeus_kills)::integer           AS zeus_kills,
  SUM(s.assists)::integer              AS assists,
  SUM(s.flash_assists)::integer        AS flash_assists,
  SUM(s.deaths)::integer               AS deaths,
  SUM(s.damage)::integer               AS damage,
  SUM(s.team_damage)::integer          AS team_damage,
  SUM(s.he_damage)::integer            AS he_damage,
  SUM(s.molotov_damage)::integer       AS molotov_damage,
  SUM(s.flashes_thrown)::integer       AS flashes_thrown,
  SUM(s.enemies_flashed)::integer      AS enemies_flashed,
  SUM(s.team_flashed)::integer         AS team_flashed,
  CASE WHEN SUM(s.flash_duration_count) > 0
       THEN (SUM(s.flash_duration_sum) / SUM(s.flash_duration_count))::numeric
       ELSE 0::numeric
  END                                  AS avg_flash_duration,
  SUM(s.two_kill_rounds)::integer      AS two_kill_rounds,
  SUM(s.three_kill_rounds)::integer    AS three_kill_rounds,
  SUM(s.four_kill_rounds)::integer     AS four_kill_rounds,
  SUM(s.five_kill_rounds)::integer     AS five_kill_rounds
FROM public.player_match_map_stats s
GROUP BY s.steam_id, s.match_id;
