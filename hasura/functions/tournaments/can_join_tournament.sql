CREATE OR REPLACE FUNCTION public.can_join_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_roster boolean;
    is_team_admin boolean;
BEGIN
    -- Check if tournament is cancelled or registration is not open
    IF tournament.status IN ('Cancelled', 'CancelledMinTeams') OR tournament.status != 'RegistrationOpen' THEN
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
    
    -- Check if the player is a team admin for this tournament
    SELECT EXISTS (
        SELECT 1
        FROM tournament_teams tt
        WHERE
            tournament_id = tournament.id
            AND owner_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO is_team_admin;

    -- Player can join if they are not on a roster and not a team admin
    RETURN NOT (on_roster OR is_team_admin);
END;
$$;