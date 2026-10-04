-- Hand-granted 1st/2nd/3rd awards used to be stored without their placement,
-- so the tournament podium could not place them. The award a placement
-- resolves to is inlined here because resolve_tournament_award is created by
-- the functions phase, which runs after migrations.
WITH placed AS (
    SELECT ar.id,
           resolved.placement,
           row_number() OVER (
               PARTITION BY ar.tournament_id, ar.tournament_team_id,
                            ar.player_steam_id, ar.team_id, resolved.placement
               ORDER BY ar.created_at, ar.id
           ) AS nth
      FROM public.award_recipients ar
      CROSS JOIN LATERAL (
          SELECT candidate.n AS placement
            FROM unnest(ARRAY[1, 2, 3]) AS candidate(n)
           WHERE COALESCE(
                     (SELECT ta.award_id
                        FROM public.tournament_awards ta
                       WHERE ta.tournament_id = ar.tournament_id
                         AND ta.placement = candidate.n),
                     (SELECT a.id
                        FROM public.awards a
                       WHERE a.system_key = CASE candidate.n
                             WHEN 1 THEN 'tournament_gold'
                             WHEN 2 THEN 'tournament_silver'
                             WHEN 3 THEN 'tournament_bronze'
                       END)
                 ) = ar.award_id
           ORDER BY candidate.n
           LIMIT 1
      ) resolved
     WHERE ar.source = 'manual'
       AND ar.tournament_id IS NOT NULL
       AND ar.placement IS NULL
)
UPDATE public.award_recipients ar
   SET placement = placed.placement
  FROM placed
 WHERE placed.id = ar.id
   AND placed.nth = 1
   AND NOT EXISTS (
       SELECT 1 FROM public.award_recipients held
        WHERE held.tournament_id = ar.tournament_id
          AND held.tournament_team_id IS NOT DISTINCT FROM ar.tournament_team_id
          AND held.placement = placed.placement
          AND (held.player_steam_id = ar.player_steam_id
               OR held.team_id = ar.team_id)
   );
