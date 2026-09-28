-- For a roster add made on somebody else's behalf: the session's player against
-- `target`. Nothing to check with no player on the session (the API's own
-- connection, a cascade), for a player adding themselves, or for staff at or
-- above `exempt_role`.
CREATE OR REPLACE FUNCTION public.assert_session_not_blocked(target bigint, exempt_role text)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    _session json := NULLIF(current_setting('hasura.user', true), '')::json;
    _actor bigint := public.hasura_session_steam_id();
BEGIN
    IF _actor IS NULL OR _actor = target THEN
        RETURN;
    END IF;

    IF COALESCE(public.is_above_role(exempt_role, _session), false) THEN
        RETURN;
    END IF;

    PERFORM public.assert_not_blocked(_actor, target);
END;
$$;

-- The same check as a trigger, for tables whose only writer adds somebody else
-- directly: TG_ARGV[0] names the steam id column, TG_ARGV[1] the exempt role.
CREATE OR REPLACE FUNCTION public.tbi_assert_session_not_blocked() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_session_not_blocked(
        (to_jsonb(NEW) ->> TG_ARGV[0])::bigint,
        TG_ARGV[1]
    );

    RETURN NEW;
END;
$$;
