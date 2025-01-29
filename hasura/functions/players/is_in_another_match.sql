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
        pm.status = 'Live'
        or 
        pm.status = 'Veto'
        or 
        pm.status = 'WaitingForCheckIn'
        or 
        pm.status = 'WaitingForServer'
    );
END;
$$
