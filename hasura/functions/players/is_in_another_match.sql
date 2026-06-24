CREATE OR REPLACE FUNCTION public.is_in_another_match(player public.players)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM get_player_matches(player) AS pm
        WHERE (
            pm.status IN ('Live', 'Veto', 'WaitingForCheckIn', 'WaitingForServer')
            -- A scheduled match only ties the player up once it's within an hour
            -- of kickoff; before that they're free to play other matches.
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
