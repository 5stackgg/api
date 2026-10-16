-- Starts from the few active matches, never from the player's history. The
-- LIMIT keeps the lineup lookup a per-match index probe (a plain join or
-- EXISTS lets the cached generic plan walk every lineup the player has ever
-- been in), and the CTE keeps match_series_decided to the player's own matches.
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
            WHERE mlp.steam_id = player.steam_id
              AND mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
            LIMIT 1
        ) member
        WHERE m.status IN ('Veto', 'WaitingForCheckIn', 'WaitingForServer', 'Live', 'Scheduled')
          AND m.source <> 'practice'
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
