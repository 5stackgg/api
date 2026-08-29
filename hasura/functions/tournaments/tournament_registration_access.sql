-- Has this player traded the passcode for an unlock on this tournament?
-- The insert triggers on tournament_teams / tournament_free_agents ask this;
-- unlockTournamentRegistration is what writes the row.
CREATE OR REPLACE FUNCTION public.tournament_registration_unlocked(
    _tournament_id uuid,
    _player_steam_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.tournament_registration_unlocks u
        WHERE u.tournament_id = _tournament_id
          AND u.player_steam_id = _player_steam_id
    );
$$;

-- Computed-field form, so the join UI can tell "locked" from "already unlocked"
-- without being handed the passcode to compare against.
CREATE OR REPLACE FUNCTION public.tournament_registration_unlocked_for_session(
    tournament public.tournaments,
    hasura_session json
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT NOT tournament.invite_only
        OR public.is_tournament_organizer(tournament, hasura_session)
        OR public.tournament_registration_unlocked(
               tournament.id,
               (hasura_session ->> 'x-hasura-user-id')::bigint
           );
$$;

-- registration_passcode is a column only the tournament_organizer ROLE may
-- select, but a plain `user` with can_create_tournaments owns tournaments too
-- and has to be able to read back the passcode they set. Granting the column to
-- the `user` role would hand it to every logged-in player for every tournament
-- they can see -- which is the gate itself -- so the organizer reads it through
-- this row-level field instead.
CREATE OR REPLACE FUNCTION public.tournament_organizer_registration_passcode(
    tournament public.tournaments,
    hasura_session json
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN public.is_tournament_organizer(tournament, hasura_session)
        THEN tournament.registration_passcode
    END;
$$;
