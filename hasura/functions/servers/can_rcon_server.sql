-- An elevated role is not by itself a licence to drive every server: match
-- servers are reachable only by that match's organizer, while dedicated
-- servers stay open to the moderation roles that police public play.
--
-- The organizer lookup reads matches directly, never through a role's select
-- permission: those hide practice matches from every role, and a practice
-- session's host is its match's organizer.
CREATE OR REPLACE FUNCTION public.can_rcon_server(server public.servers, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF is_above_role('administrator', hasura_session) THEN
        RETURN true;
    END IF;

    IF is_above_role('moderator', hasura_session) IS NOT TRUE THEN
        RETURN false;
    END IF;

    IF server.is_dedicated THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.matches m
         WHERE m.server_id = server.id
           AND m.status NOT IN ('Canceled', 'Finished', 'Forfeit', 'Surrendered', 'Tie')
           AND public.is_match_organizer(m, hasura_session)
    );
END;
$$;
