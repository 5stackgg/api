-- Access + connect primitives for nade practice sessions. The connection
-- fields deliberately delegate to the match functions rather than re-deriving
-- a host and password: a practice session IS a match, and two implementations
-- of "where do I connect" would drift.

CREATE OR REPLACE FUNCTION public.is_nade_practice_member(
    session public.nade_practice_sessions,
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
CREATE OR REPLACE FUNCTION public.can_view_nade_practice_session(
    session public.nade_practice_sessions,
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

    IF public.is_nade_practice_member(session, hasura_session) THEN
        RETURN true;
    END IF;

    IF session.is_open THEN
        RETURN true;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.nade_practice_invites i
         WHERE i.nade_practice_session_id = session.id
           AND i.steam_id = _steam_id
    ) THEN
        RETURN true;
    END IF;

    RETURN public.is_nade_team_member(session.team_id, _steam_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_nade_practice_session(
    session public.nade_practice_sessions,
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

CREATE OR REPLACE FUNCTION public.nade_practice_connection_link(
    session public.nade_practice_sessions,
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

CREATE OR REPLACE FUNCTION public.nade_practice_connection_string(
    session public.nade_practice_sessions,
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
