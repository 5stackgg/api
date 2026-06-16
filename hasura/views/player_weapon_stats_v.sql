-- Per-(player, match, weapon_class) accuracy rolled up across all maps.
DROP VIEW IF EXISTS public.player_weapon_stats_v;
CREATE OR REPLACE VIEW public.player_weapon_stats_v AS
SELECT
  w.steam_id,
  w.match_id,
  w.weapon_class,
  SUM(w.shots)::integer              AS shots,
  SUM(w.hits)::integer               AS hits,
  SUM(w.shots_spotted)::integer      AS shots_spotted,
  SUM(w.hits_spotted)::integer       AS hits_spotted,
  SUM(w.first_bullet_shots)::integer AS first_bullet_shots,
  SUM(w.first_bullet_hits)::integer  AS first_bullet_hits
FROM public.player_aim_weapon_stats w
GROUP BY w.steam_id, w.match_id, w.weapon_class;
