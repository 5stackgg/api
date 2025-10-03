DROP FUNCTION IF EXISTS public.get_match_tv_connection_link(match matches, hasura_session json);

CREATE OR REPLACE FUNCTION public.get_match_tv_connection_string(match public.matches, hasura_session json) RETURNS text
     LANGUAGE plpgsql STABLE
     AS $$
 DECLARE
     password text;
     server_host text;
     tv_port int;
     started_at timestamp;
     tv_delay int;
 BEGIN
     SELECT s.host, s.tv_port, m.started_at, mo.tv_delay
     INTO server_host, tv_port, started_at, tv_delay
     FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        INNER JOIN match_options mo on mo.id = m.match_options_id
     WHERE m.id = match.id
     LIMIT 1;

    IF server_host IS NULL OR started_at IS NULL OR NOW() < started_at + (tv_delay || ' seconds')::interval THEN
         RETURN NULL;
     END IF;

    password := player_match_password(match, 'tv', hasura_session);

    if(password is null) then
        return null;
    end if;
    
    RETURN CONCAT('connect ', CONCAT(server_host, ':', tv_port), '; password ', password);
 END;
 $$;