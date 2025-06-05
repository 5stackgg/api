CREATE OR REPLACE FUNCTION public.can_manage_tournament_team(tournament_team public.tournament_teams, hasura_session json) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN

    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    IF tournament_team.team_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM tournament_team_roster 
                WHERE 
                    tournament_id = tournament_team.tournament_id
                    AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint 
                    AND role IN ('Admin')
            );
    END IF;

    IF tournament_team.owner_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint THEN 
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM tournament_team_roster 
            WHERE 
                tournament_id = tournament_team.tournament_id
                AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint 
                AND role IN ('Admin')
    );
END;
$$;