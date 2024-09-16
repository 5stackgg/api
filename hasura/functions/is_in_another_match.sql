CREATE OR REPLACE FUNCTION public.is_in_another_match(player public.players, hasura_session json)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM get_player_matches(player) AS pm
        WHERE pm.status = 'Live'
    );
END;
$$
