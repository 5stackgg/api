CREATE OR REPLACE VIEW public.v_player_multi_kills AS
 WITH kill_counts AS (
   SELECT player_kills.match_id,
      player_kills.attacker_steam_id,
      player_kills.round,
      count(*) AS kills
   FROM public.player_kills
   GROUP BY player_kills.match_id, player_kills.round, player_kills.attacker_steam_id
 )
 SELECT match_id,
    attacker_steam_id,
    round,
    kills
 FROM kill_counts
 WHERE kills > 1;