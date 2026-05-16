DROP VIEW IF EXISTS public.player_match_stats_v;
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
  SUM(s.five_kill_rounds)::integer     AS five_kill_rounds,
  SUM(s.trade_kill_opportunities)::integer   AS trade_kill_opportunities,
  SUM(s.trade_kill_attempts)::integer        AS trade_kill_attempts,
  SUM(s.trade_kill_successes)::integer       AS trade_kill_successes,
  SUM(s.traded_death_opportunities)::integer AS traded_death_opportunities,
  SUM(s.traded_death_successes)::integer     AS traded_death_successes,
  SUM(s.shots_fired)::integer                       AS shots_fired,
  SUM(s.hits)::integer                              AS hits,
  SUM(s.headshot_hits)::integer                     AS headshot_hits,
  SUM(s.non_awp_hits)::integer                      AS non_awp_hits,
  SUM(s.hits_at_spotted)::integer                   AS hits_at_spotted,
  SUM(s.shots_at_spotted)::integer                  AS shots_at_spotted,
  CASE WHEN SUM(s.time_to_damage_count) > 0
       THEN (SUM(s.time_to_damage_sum_s) / SUM(s.time_to_damage_count))::numeric
       ELSE NULL
  END                                               AS avg_time_to_damage_s,
  SUM(s.spotted_count)::integer                     AS spotted_count,
  SUM(s.spotted_with_damage_count)::integer         AS spotted_with_damage_count,
  SUM(s.he_throws)::integer                         AS he_throws,
  SUM(s.molotov_throws)::integer                    AS molotov_throws,
  SUM(s.smoke_throws)::integer                      AS smoke_throws,
  SUM(s.decoy_throws)::integer                      AS decoy_throws,
  SUM(s.counter_strafed_shots)::integer             AS counter_strafed_shots,
  SUM(s.counter_strafe_eligible_shots)::integer     AS counter_strafe_eligible_shots,
  SUM(s.spray_shots)::integer                       AS spray_shots,
  SUM(s.spray_hits)::integer                        AS spray_hits,
  CASE WHEN SUM(s.crosshair_angle_count) > 0
       THEN (SUM(s.crosshair_angle_sum_deg) / SUM(s.crosshair_angle_count))::numeric
       ELSE NULL
  END                                               AS avg_crosshair_angle_deg,
  SUM(s.rounds_played)::integer                     AS rounds_played
FROM public.player_match_map_stats s
GROUP BY s.steam_id, s.match_id;
