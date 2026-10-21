-- Access + connect primitives for utility practice sessions. The connection
-- fields deliberately delegate to the match functions rather than re-deriving
-- a host and password: a practice session IS a match, and two implementations
-- of "where do I connect" would drift.

CREATE OR REPLACE FUNCTION public.is_utility_practice_member(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF session.host_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    IF session.match_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.match_lineup_players mlp
          INNER JOIN public.match_lineups ml ON ml.id = mlp.match_lineup_id
         WHERE ml.match_id = session.match_id
           AND mlp.steam_id = _steam_id
    );
END;
$$;

-- Who may see the session row at all. Being able to see it is what surfaces the
-- invite code, so it is exactly the set that may attempt a join.
CREATE OR REPLACE FUNCTION public.can_view_utility_practice_session(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF hasura_session ->> 'x-hasura-role'
        IN ('admin', 'administrator', 'moderator') THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF public.is_utility_practice_member(session, hasura_session) THEN
        RETURN true;
    END IF;

    IF session.is_open THEN
        RETURN true;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.utility_practice_invites i
         WHERE i.utility_practice_session_id = session.id
           AND i.steam_id = _steam_id
    ) THEN
        RETURN true;
    END IF;

    IF session.access = 'Friends'
        AND public.are_friends(session.host_steam_id, _steam_id) THEN
        RETURN true;
    END IF;

    RETURN public.is_utility_team_member(session.team_id, _steam_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_utility_practice_session(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF hasura_session ->> 'x-hasura-role'
        IN ('admin', 'administrator', 'moderator') THEN
        RETURN true;
    END IF;

    RETURN _steam_id IS NOT NULL AND session.host_steam_id = _steam_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.utility_practice_connection_link(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _match public.matches;
BEGIN
    IF session.match_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT m.* INTO _match FROM public.matches m WHERE m.id = session.match_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN public.get_match_connection_link(_match, hasura_session);
END;
$$;

CREATE OR REPLACE FUNCTION public.utility_practice_connection_string(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _match public.matches;
BEGIN
    IF session.match_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT m.* INTO _match FROM public.matches m WHERE m.id = session.match_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    RETURN public.get_match_connection_string(_match, hasura_session);
END;
$$;

-- The staff console's server. session.match cannot answer it: the matches
-- select hides practice matches from every role. Given only to viewers
-- can_rcon_server lets in, since the gateway drops a refused command without a
-- reply; everyone else gets NULL rather than a permission error, because every
-- member shares the one session subscription.
CREATE OR REPLACE FUNCTION public.utility_practice_server_id(
    session public.utility_practice_sessions,
    hasura_session json
) RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT s.id
          FROM public.matches m
          INNER JOIN public.servers s ON s.id = m.server_id
         WHERE m.id = session.match_id
           AND public.can_rcon_server(s, hasura_session)
    );
END;
$$;
