DROP FUNCTION IF EXISTS public.get_match_tv_connection_link(match matches, hasura_session json);

CREATE OR REPLACE FUNCTION public.get_match_tv_connection_string(match public.matches, hasura_session json) RETURNS text
     LANGUAGE plpgsql STABLE
     AS $$
 DECLARE
     password text;
     connection_string text;
     server_host text;
     tv_port int;
 BEGIN
     SELECT s.host, s.tv_port
     INTO server_host, tv_port
     FROM matches m
     INNER JOIN servers s ON s.id = m.server_id
     WHERE m.id = match.id
     LIMIT 1;

     IF server_host IS NULL THEN
         RETURN NULL;
     END IF;

    password := player_match_password(match, 'tv', hasura_session);

    if(password is null) then
        return null;
    end if;
   
    connection_string := CONCAT('connect ', server_host, ':', tv_port, '; password ', password);
    
    RETURN connection_string;
 END;
 $$;