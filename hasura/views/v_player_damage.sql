CREATE OR REPLACE VIEW public.v_player_damage AS
 WITH matchroundscount AS (
         SELECT pd.attacker_steam_id AS player_steam_id,
            sum(pd.damage) AS total_damage,
            count(DISTINCT mr.id) AS match_total_rounds
           FROM (public.player_damages pd
             LEFT JOIN public.match_map_rounds mr ON ((mr.match_map_id = pd.match_id)))
          GROUP BY pd.attacker_steam_id
        )
 SELECT matchroundscount.player_steam_id,
    matchroundscount.total_damage,
    matchroundscount.match_total_rounds AS total_rounds,
        CASE
            WHEN (matchroundscount.match_total_rounds > 0) THEN (matchroundscount.total_damage / matchroundscount.match_total_rounds)
            ELSE NULL::bigint
        END AS avg_damage_per_round
   FROM matchroundscount;