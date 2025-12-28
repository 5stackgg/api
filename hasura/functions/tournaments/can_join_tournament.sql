CREATE OR REPLACE FUNCTION public.can_join_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_roster boolean;
    is_team_admin boolean;
    is_organizer boolean;
BEGIN
    -- Check if tournament is cancelled or registration is not open
    IF tournament.status IN ('Cancelled', 'CancelledMinTeams') THEN
        RETURN false;
    END IF;

    -- Check if the player is already on a roster for this tournament
    SELECT EXISTS (
        SELECT 1
        FROM tournament_team_roster ttr
        WHERE
            tournament_id = tournament.id
            AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO on_roster;

    if(on_roster) THEN
        RETURN false;
    END IF;

    is_organizer = hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' ;
     
    IF is_organizer AND tournament.status = 'Setup' THEN
        RETURN true;
    END IF;
    
    IF tournament.status != 'RegistrationOpen' THEN
        RETURN false;
    END IF;
    
    IF hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    -- Check if the player is a team admin for this tournament
    SELECT EXISTS (
        SELECT 1
        FROM tournament_teams tt
        WHERE
            tournament_id = tournament.id
            AND owner_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO is_team_admin;

    -- Player can join if they are not on a roster and not a team admin
    RETURN NOT is_team_admin;
END;
$$;