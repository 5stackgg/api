CREATE OR REPLACE VIEW public.v_player_match_kills AS
 SELECT player_kills.attacker_steam_id AS player_steam_id,
    count(*) AS kills,
    ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id)) AS total_matches,
    (count(*) / ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id))) AS avg_kills_per_game
   FROM public.player_kills
  GROUP BY player_kills.attacker_steam_id
  ORDER BY (count(*) / ( SELECT count(DISTINCT subquery.match_id) AS count
           FROM public.player_kills subquery
          WHERE (subquery.attacker_steam_id = player_kills.attacker_steam_id))) DESC;