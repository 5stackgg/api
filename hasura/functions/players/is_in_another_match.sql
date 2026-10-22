-- Looks up every active lineup at once in the player's own slice of the
-- (steam_id, match_lineup_id) index, so neither the player's history nor the
-- number of active matches makes a friends list refresh dearer.
-- idx_matches_active_schedule answers the active statuses and the Scheduled
-- cut-off as two index ranges. There is no index on
-- match_lineup_players.steam_id alone: the planner prices one the same as the
-- unique key and would then read whole histories.
-- The CTE keeps match_series_decided to the player's own matches.
CREATE OR REPLACE FUNCTION public.is_in_another_match(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    WITH active AS MATERIALIZED (
        SELECT m.id, m.status, m.scheduled_at, m.lineup_1_id, m.lineup_2_id
        FROM matches m
        WHERE m.source <> 'practice'
          AND (
              m.status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live')
              OR (m.status = 'Scheduled' AND m.scheduled_at <= NOW() + INTERVAL '1 hour')
          )
    ), my_lineups AS MATERIALIZED (
        SELECT mlp.match_lineup_id
        FROM match_lineup_players mlp
        WHERE mlp.steam_id = player.steam_id
          AND mlp.match_lineup_id = ANY (ARRAY(
              SELECT a.lineup_1_id FROM active a
              UNION ALL
              SELECT a.lineup_2_id FROM active a
          ))
    ), mine AS MATERIALIZED (
        SELECT a.id, a.status, a.scheduled_at
        FROM active a
        WHERE a.lineup_1_id IN (SELECT match_lineup_id FROM my_lineups)
           OR a.lineup_2_id IN (SELECT match_lineup_id FROM my_lineups)
    )
    SELECT EXISTS (
        SELECT 1
        FROM mine pm
        WHERE (
            pm.status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer')
            OR (pm.status = 'Live' AND NOT match_series_decided(pm.id))
            OR (
                pm.status = 'Scheduled'
                AND pm.scheduled_at IS NOT NULL
                AND pm.scheduled_at <= NOW() + INTERVAL '1 hour'
            )
        )
        AND NOT EXISTS (
            SELECT 1
            FROM tournament_brackets tb
            INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
            INNER JOIN tournaments t ON t.id = ts.tournament_id
            WHERE tb.match_id = pm.id
              AND t.status = 'Paused'
        )
    );
$$;
