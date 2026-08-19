-- Visibility/edit access primitives for the utility library. Single file so the
-- is_* helpers exist before their callers within one boot apply, matching
-- hasura/functions/events/event_access.sql.

-- LANGUAGE sql is safe here: every referenced relation is created in the
-- migrations boot phase, which runs before hasura/functions.
CREATE OR REPLACE FUNCTION public.is_utility_team_member(
    _team_id uuid,
    _steam_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT _team_id IS NOT NULL AND _steam_id IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.id = _team_id AND t.owner_steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1 FROM public.team_roster tr
            WHERE tr.team_id = _team_id AND tr.player_steam_id = _steam_id
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.is_utility_team_admin(
    _team_id uuid,
    _steam_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT _team_id IS NOT NULL AND _steam_id IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.id = _team_id AND t.owner_steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1 FROM public.team_roster tr
            WHERE tr.team_id = _team_id
              AND tr.player_steam_id = _steam_id
              AND tr.role = 'Admin'
        )
    );
$$;

-- LANGUAGE plpgsql: bodies are not parsed for object references at CREATE
-- time, so these are safe regardless of the order files are applied in.
CREATE OR REPLACE FUNCTION public.can_view_utility_lineup(
    lineup public.utility_lineups,
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

    IF lineup.archived_at IS NOT NULL THEN
        RETURN lineup.author_steam_id = _steam_id;
    END IF;

    IF lineup.visibility = 'Public' THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF lineup.author_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    IF lineup.visibility = 'Team' THEN
        RETURN public.is_utility_team_member(lineup.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_edit_utility_lineup(
    lineup public.utility_lineups,
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

    IF lineup.author_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    -- A team book is the team's to curate, so a team admin can fix a lineup
    -- the author has stopped maintaining.
    IF lineup.visibility = 'Team' THEN
        RETURN public.is_utility_team_admin(lineup.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_view_utility_collection(
    collection public.utility_collections,
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

    IF collection.visibility = 'Public' THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF collection.owner_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    IF collection.visibility = 'Team' THEN
        RETURN public.is_utility_team_member(collection.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_edit_utility_collection(
    collection public.utility_collections,
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

    IF collection.owner_steam_id = _steam_id THEN
        RETURN true;
    END IF;

    IF collection.visibility = 'Team' THEN
        RETURN public.is_utility_team_admin(collection.team_id, _steam_id);
    END IF;

    RETURN false;
END;
$$;

-- The viewer's own vote, so the UI can render the toggled state without a
-- second round trip.
CREATE OR REPLACE FUNCTION public.utility_lineup_my_vote(
    lineup public.utility_lineups,
    hasura_session json
) RETURNS smallint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
    _vote smallint;
BEGIN
    IF _steam_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT v.vote INTO _vote
    FROM public.utility_lineup_votes v
    WHERE v.utility_lineup_id = lineup.id AND v.steam_id = _steam_id;

    RETURN _vote;
END;
$$;

CREATE OR REPLACE FUNCTION public.utility_lineup_is_favorited(
    lineup public.utility_lineups,
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

    RETURN EXISTS (
        SELECT 1 FROM public.utility_lineup_favorites f
        WHERE f.utility_lineup_id = lineup.id AND f.steam_id = _steam_id
    );
END;
$$;
