CREATE OR REPLACE FUNCTION public.is_above_role(role text, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT array_position(
        ARRAY['guest', 'user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'],
        hasura_session ->> 'x-hasura-role'
    ) >= array_position(
        ARRAY['guest', 'user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'],
        role::text
    );
$$;

CREATE OR REPLACE FUNCTION public.is_role_below(role text, user_role text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT array_position(
        ARRAY['guest', 'user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'],
        role::text
    ) <= array_position(
        ARRAY['guest', 'user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'],
        user_role
    );
$$;
