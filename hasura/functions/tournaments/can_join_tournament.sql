CREATE OR REPLACE FUNCTION public.can_join_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    _steam_id bigint;
    on_roster boolean;
    is_team_admin boolean;
    is_organizer boolean;
BEGIN
    -- Check if tournament is cancelled or registration is not open
    IF tournament.status IN ('Cancelled', 'CancelledMinTeams') THEN
        RETURN false;
    END IF;

    _steam_id := (hasura_session ->> 'x-hasura-user-id')::bigint;

    is_organizer = hasura_session ->> 'x-hasura-role' = 'administrator' OR hasura_session ->> 'x-hasura-role' = 'tournament_organizer' ;

    IF is_organizer AND tournament.status = 'Setup' THEN
        RETURN true;
    END IF;

    IF tournament.status != 'RegistrationOpen' THEN
        RETURN false;
    END IF;

    IF is_organizer THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    -- Check if the player is already on a roster for this tournament
    SELECT EXISTS (
        SELECT 1
        FROM tournament_team_roster ttr
        WHERE
            tournament_id = tournament.id
            AND player_steam_id = _steam_id
    ) INTO on_roster;

    -- Check if the player already owns a team in this tournament
    SELECT EXISTS (
        SELECT 1
        FROM tournament_teams tt
        WHERE
            tournament_id = tournament.id
            AND owner_steam_id = _steam_id
    ) INTO is_team_admin;

    -- First-time / pickup join: not yet on a roster and not already owning a
    -- team in this tournament.
    IF NOT on_roster AND NOT is_team_admin THEN
        RETURN true;
    END IF;

    -- Otherwise they can still register another team they manage that is not
    -- already in this tournament (e.g. an A team and a B team that share
    -- members): being on another team's roster does not block registration.
    RETURN EXISTS (
        SELECT 1
        FROM public.teams t
        WHERE public.manages_team(t.id, _steam_id)
          AND NOT EXISTS (
              SELECT 1
              FROM public.tournament_teams tt
              WHERE tt.tournament_id = tournament.id
                AND tt.team_id = t.id
          )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.joined_tournament(tournament public.tournaments, hasura_session json) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    on_roster boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM tournament_team_roster ttr
        WHERE
            tournament_id = tournament.id
            AND player_steam_id = (hasura_session ->> 'x-hasura-user-id')::bigint
    ) INTO on_roster;

    RETURN on_roster;
END;
$$;