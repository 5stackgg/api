-- A GraphQL socket keeps the role it opened with until its session expires, so
-- a demoted player's session still claims the role they lost. True when the
-- request's player holds the session's role, or a higher one, right now; a
-- missing or malformed user id is never current.
CREATE OR REPLACE FUNCTION public.session_role_is_current() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    WITH session AS (
        SELECT NULLIF(current_setting('hasura.user', true), '')::json AS value
    )
    SELECT COALESCE(
        public.is_role_below(
            session.value ->> 'x-hasura-role',
            (SELECT p.role::text
               FROM public.players p
              WHERE p.steam_id = CASE
                  WHEN session.value ->> 'x-hasura-user-id' ~ '^[0-9]{1,18}$'
                      THEN (session.value ->> 'x-hasura-user-id')::bigint
              END)
        ),
        false
    )
    FROM session;
$$;
