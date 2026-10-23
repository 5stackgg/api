-- A GraphQL socket keeps the role it opened with until its session expires, so
-- a demoted player's session still claims the role they lost. True when the
-- request's player holds the session's role, or a higher one, right now.
CREATE OR REPLACE FUNCTION public.session_role_is_current() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(
        public.is_role_below(
            NULLIF(current_setting('hasura.user', true), '')::json ->> 'x-hasura-role',
            (SELECT p.role::text FROM public.players p WHERE p.steam_id = public.hasura_session_steam_id())
        ),
        false
    );
$$;
