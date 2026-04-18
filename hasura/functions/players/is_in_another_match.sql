CREATE OR REPLACE FUNCTION public.is_in_another_match(player public.players)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM get_player_matches(player) AS pm
        WHERE
        (
            pm.status = 'Live'
            or
            pm.status = 'Veto'
            or
            pm.status = 'WaitingForCheckIn'
            or
            pm.status = 'WaitingForServer'
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
END;
$$
