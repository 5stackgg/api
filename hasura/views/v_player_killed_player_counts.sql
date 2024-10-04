CREATE OR REPLACE VIEW public.v_player_killed_player_counts AS
 SELECT player_kills.attacker_steam_id AS player_id,
    player_kills.attacked_steam_id AS victim_id,
    count(*) AS kill_count
   FROM public.player_kills
  GROUP BY player_kills.attacker_steam_id, player_kills.attacked_steam_id
  ORDER BY player_kills.attacker_steam_id, player_kills.attacked_steam_id;