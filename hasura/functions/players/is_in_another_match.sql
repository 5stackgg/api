-- Starts from the few active matches, never from the player's history.
-- idx_matches_active_schedule answers the active statuses and the Scheduled
-- cut-off as two index ranges, so matches scheduled further out are never read.
-- Each lineup is probed on both columns of its unique key, so any index the
-- planner picks reads a single entry; an index on steam_id alone would read the
-- player's whole history instead, which is why match_lineup_players has none.
-- The CTE keeps match_series_decided to the player's own matches.
CREATE OR REPLACE FUNCTION public.is_in_another_match(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    WITH mine AS MATERIALIZED (
        SELECT m.id, m.status, m.scheduled_at
        FROM matches m
        CROSS JOIN LATERAL (
            SELECT 1
            FROM match_lineup_players mlp
            WHERE mlp.match_lineup_id = m.lineup_1_id
              AND mlp.steam_id = player.steam_id
            UNION ALL
            SELECT 1
            FROM match_lineup_players mlp
            WHERE mlp.match_lineup_id = m.lineup_2_id
              AND mlp.steam_id = player.steam_id
            LIMIT 1
        ) member
        WHERE m.source <> 'practice'
          AND (
              m.status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live')
              OR (m.status = 'Scheduled' AND m.scheduled_at <= NOW() + INTERVAL '1 hour')
          )
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
