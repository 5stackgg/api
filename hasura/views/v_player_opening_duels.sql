CREATE OR REPLACE VIEW public.v_player_opening_duels AS
 WITH ranked_kills AS (
         SELECT player_kills.match_id,
            player_kills.match_map_id,
            player_kills.attacker_steam_id AS steam_id,
            row_number() OVER (PARTITION BY player_kills.match_id, player_kills.match_map_id, player_kills.round ORDER BY player_kills."time") AS kill_rank,
            true AS is_attacker,
            (player_kills.attacker_steam_id = player_kills.attacked_steam_id) AS is_success
           FROM public.player_kills
        UNION ALL
         SELECT player_kills.match_id,
            player_kills.match_map_id,
            player_kills.attacked_steam_id AS steam_id,
            row_number() OVER (PARTITION BY player_kills.match_id, player_kills.match_map_id, player_kills.round ORDER BY player_kills."time") AS kill_rank,
            false AS is_attacker,
            (player_kills.attacker_steam_id <> player_kills.attacked_steam_id) AS is_success
           FROM public.player_kills
        )
 SELECT ranked_kills.match_id,
    ranked_kills.match_map_id,
    ranked_kills.steam_id,
    sum(
        CASE
            WHEN (ranked_kills.is_attacker = true) THEN 1
            ELSE 0
        END) AS attempts,
    sum((
        CASE
            WHEN (ranked_kills.is_attacker = true) THEN 1
            ELSE 0
        END *
        CASE
            WHEN (ranked_kills.is_attacker = ranked_kills.is_success) THEN 1
            ELSE 0
        END)) AS successes
   FROM ranked_kills
  WHERE (ranked_kills.kill_rank = 1)
  GROUP BY ranked_kills.match_id, ranked_kills.match_map_id, ranked_kills.steam_id;