-- An event only lets its members in while it is running, judged the way the
-- web's eventPhase does: an event with no start date has not started, and one
-- with no end date runs until it is given one.
CREATE OR REPLACE FUNCTION public.server_access_event_is_live(event public.events)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT event.starts_at IS NOT NULL
       AND event.starts_at <= now()
       AND (event.ends_at IS NULL OR event.ends_at >= now());
$$;

-- Everyone a restricted server lets in. Staff always get in so a restricted
-- server can still be moderated. The event branches mirror is_event_member.
CREATE OR REPLACE FUNCTION public.server_allowed_steam_ids(_server_id uuid)
RETURNS TABLE (steam_id bigint)
LANGUAGE sql
STABLE
AS $$
    WITH server AS (
        SELECT s.access_min_role
          FROM public.servers s
         WHERE s.id = _server_id
    ),
    live_events AS (
        SELECT e.id, e.organizer_steam_id
          FROM public.server_access_events sae
          JOIN public.events e ON e.id = sae.event_id
         WHERE sae.server_id = _server_id
           AND public.server_access_event_is_live(e)
    )
    SELECT sap.steam_id
      FROM public.server_access_players sap
     WHERE sap.server_id = _server_id
    UNION
    SELECT p.steam_id
      FROM public.players p
     WHERE public.is_role_below('moderator', p.role)
        OR EXISTS (
            SELECT 1 FROM server
             WHERE server.access_min_role IS NOT NULL
               AND public.is_role_below(server.access_min_role, p.role)
        )
    UNION
    SELECT le.organizer_steam_id FROM live_events le
    UNION
    SELECT eo.steam_id
      FROM live_events le
      JOIN public.event_organizers eo ON eo.event_id = le.id
    UNION
    SELECT ep.steam_id
      FROM live_events le
      JOIN public.event_players ep ON ep.event_id = le.id
    UNION
    SELECT tr.player_steam_id
      FROM live_events le
      JOIN public.event_teams et ON et.event_id = le.id
      JOIN public.team_roster tr ON tr.team_id = et.team_id
    UNION
    SELECT ttr.player_steam_id
      FROM live_events le
      JOIN public.event_tournaments evt ON evt.event_id = le.id
      JOIN public.tournament_team_roster ttr ON ttr.tournament_id = evt.tournament_id
    UNION
    SELECT torg.steam_id
      FROM live_events le
      JOIN public.event_tournaments evt ON evt.event_id = le.id
      JOIN public.tournament_organizers torg ON torg.tournament_id = evt.tournament_id
    UNION
    SELECT tt.owner_steam_id
      FROM live_events le
      JOIN public.event_tournaments evt ON evt.event_id = le.id
      JOIN public.tournament_teams tt ON tt.tournament_id = evt.tournament_id
     WHERE tt.owner_steam_id IS NOT NULL;
$$;

-- Answers for one viewer without expanding the whole allowlist: a role rule on
-- a big deployment covers every registered player.
CREATE OR REPLACE FUNCTION public.can_connect_to_server(server public.servers, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    viewer bigint;
BEGIN
    IF NOT server.access_restricted THEN
        RETURN true;
    END IF;

    IF COALESCE(public.is_above_role('moderator', hasura_session), false) THEN
        RETURN true;
    END IF;

    viewer := NULLIF(NULLIF(hasura_session ->> 'x-hasura-user-id', ''), '0')::bigint;

    IF viewer IS NULL THEN
        RETURN false;
    END IF;

    IF server.access_min_role IS NOT NULL
       AND COALESCE(public.is_above_role(server.access_min_role, hasura_session), false) THEN
        RETURN true;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.server_access_players sap
         WHERE sap.server_id = server.id AND sap.steam_id = viewer
    ) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.server_access_events sae
          JOIN public.events e ON e.id = sae.event_id
         WHERE sae.server_id = server.id
           AND public.server_access_event_is_live(e)
           AND public.is_event_member(e, viewer)
    );
END;
$$;
