CREATE OR REPLACE FUNCTION public.can_remove_from_team(team public.teams, hasura_session json) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
BEGIN
    IF team.owner_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint THEN
        RETURN true;
    END IF;

    if hasura_session ->> 'x-hasura-role' = 'administrator' then
        RETURN true;
    END IF;
    
    RETURN EXISTS (
        SELECT 1 FROM team_roster 
        WHERE 
            team_id = team.id 
            AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint 
            AND role IN ('Admin')
        LIMIT 1
    );
END;
$$;