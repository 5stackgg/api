CREATE OR REPLACE FUNCTION public.can_manage_tournament_team(tournament_team public.tournament_teams, hasura_session json) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _user_steam_id bigint;
BEGIN

    IF hasura_session ->> 'x-hasura-role' = 'admin' OR hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' THEN
        RETURN true;
    END IF;

    _user_steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    IF _user_steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF tournament_team.owner_steam_id = _user_steam_id THEN
        RETURN true;
    END IF;

    -- Scoped to this tournament_team, never the tournament: a roster row only
    -- makes you an Admin of the team it belongs to.
    IF EXISTS (
        SELECT 1 FROM tournament_team_roster
            WHERE
                tournament_team_id = tournament_team.id
                AND player_steam_id = _user_steam_id
                AND role IN ('Admin')
    ) THEN
        RETURN true;
    END IF;

    IF tournament_team.team_id IS NOT NULL THEN
        RETURN EXISTS (
            SELECT 1 FROM teams
                WHERE
                    id = tournament_team.team_id
                    AND (owner_steam_id = _user_steam_id OR captain_steam_id = _user_steam_id)
        ) OR EXISTS (
            SELECT 1 FROM team_roster
                WHERE
                    team_id = tournament_team.team_id
                    AND player_steam_id = _user_steam_id
                    AND role IN ('Admin')
        );
    END IF;

    RETURN false;
END;
$$;
