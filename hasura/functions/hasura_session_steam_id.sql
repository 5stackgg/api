-- The steam id Hasura put on the connection for the request being served, or
-- NULL when there is none (the API's own direct connection, or a guest).
--
-- Hasura's insert column presets are per role: a role written without
-- `set: { <owner column>: x-hasura-user-id }` inserts NULL there instead,
-- because a preset column is also stripped from the insert input type, so the
-- caller cannot send it either. Stamping from the session in a BEFORE INSERT
-- trigger is role-independent and needs no metadata reload to take effect.
CREATE OR REPLACE FUNCTION "public"."hasura_session_steam_id"() RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
    SELECT NULLIF(
        NULLIF(current_setting('hasura.user', true), '') :: json ->> 'x-hasura-user-id',
        ''
    ) :: bigint;
$$;

-- Fills the steam id column named in the trigger argument when the row arrives
-- without one. Owner columns are NOT NULL, so an unstamped insert is a 23502
-- from Postgres rather than anything a caller can act on.
CREATE OR REPLACE FUNCTION "public"."tbi_stamp_session_steam_id"() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _column text := TG_ARGV[0];
    _steam_id bigint := public.hasura_session_steam_id();
BEGIN
    IF _steam_id IS NULL OR (to_jsonb(NEW) ->> _column) IS NOT NULL THEN
        RETURN NEW;
    END IF;

    RETURN jsonb_populate_record(NEW, jsonb_build_object(_column, _steam_id));
END;
$$;
