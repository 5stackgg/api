-- Visibility/upload access primitives for events. Single file so
-- is_event_member exists before its callers within one boot apply.

-- LANGUAGE sql is safe here: every referenced relation is created in the
-- migrations boot phase, which runs before hasura/functions.
CREATE OR REPLACE FUNCTION public.is_event_member(
    event public.events,
    _steam_id bigint
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT _steam_id IS NOT NULL AND (
        event.organizer_steam_id = _steam_id
        OR EXISTS (
            SELECT 1 FROM public.event_organizers eo
            WHERE eo.event_id = event.id AND eo.steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1 FROM public.event_players ep
            WHERE ep.event_id = event.id AND ep.steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1
            FROM public.event_teams et
            JOIN public.team_roster tr ON tr.team_id = et.team_id
            WHERE et.event_id = event.id AND tr.player_steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1
            FROM public.event_tournaments evt
            JOIN public.tournament_team_roster ttr
              ON ttr.tournament_id = evt.tournament_id
            WHERE evt.event_id = event.id AND ttr.player_steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1
            FROM public.event_tournaments evt
            JOIN public.tournament_organizers torg
              ON torg.tournament_id = evt.tournament_id
            WHERE evt.event_id = event.id AND torg.steam_id = _steam_id
        )
        OR EXISTS (
            SELECT 1
            FROM public.event_tournaments evt
            JOIN public.tournament_teams tt
              ON tt.tournament_id = evt.tournament_id
            WHERE evt.event_id = event.id AND tt.owner_steam_id = _steam_id
        )
    );
$$;

-- LANGUAGE plpgsql: bodies are not parsed for object references at CREATE
-- time, so ordering against sibling function files never matters on a
-- fresh install (see get_event_leaderboard.sql for the same rationale).
CREATE OR REPLACE FUNCTION public.can_view_event(
    event public.events,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _steam_id bigint := nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint;
BEGIN
    IF hasura_session ->> 'x-hasura-role'
        IN ('admin', 'administrator', 'tournament_organizer') THEN
        RETURN true;
    END IF;

    IF event.visibility = 'Public' THEN
        RETURN true;
    END IF;

    IF _steam_id IS NULL THEN
        RETURN false;
    END IF;

    IF public.is_event_member(event, _steam_id) THEN
        RETURN true;
    END IF;

    IF event.visibility = 'Friends' THEN
        -- friends holds one row per friendship regardless of direction, so
        -- match the viewer against both columns (see v_my_friends.sql).
        RETURN EXISTS (
            SELECT 1
            FROM public.friends f
            WHERE f.status = 'Accepted'
              AND (f.player_steam_id = _steam_id
                   OR f.other_player_steam_id = _steam_id)
              AND public.is_event_member(
                    event,
                    CASE WHEN f.player_steam_id = _steam_id
                         THEN f.other_player_steam_id
                         ELSE f.player_steam_id END
                  )
        );
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_upload_event_media(
    event public.events,
    hasura_session json
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN public.is_event_organizer(event, hasura_session)
        OR (
            event.media_access = 'Involved'
            AND public.is_event_member(
                  event,
                  nullif(hasura_session ->> 'x-hasura-user-id', '')::bigint
                )
        );
END;
$$;
