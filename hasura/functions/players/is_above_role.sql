CREATE OR REPLACE FUNCTION public.is_above_role(role text, hasura_session json)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    role_order text[] := ARRAY['user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'];
    me_role_index integer;
    role_index integer;
BEGIN    
    SELECT array_position(role_order, hasura_session ->> 'x-hasura-role') INTO me_role_index;

    SELECT array_position(role_order, role::text) INTO role_index;
    
    RETURN me_role_index >= role_index;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_role_below(role text, user_role text)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    role_order text[] := ARRAY['user', 'verified_user', 'streamer', 'match_organizer', 'tournament_organizer', 'administrator', 'admin'];
    me_role_index integer;
    role_index integer;
BEGIN    
    SELECT array_position(role_order, user_role) INTO me_role_index;

    SELECT array_position(role_order, role::text) INTO role_index;
    
    RETURN role_index <= me_role_index;
END;
$$;