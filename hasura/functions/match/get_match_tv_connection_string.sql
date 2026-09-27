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
     match_id uuid;
     use_playcast text;
     relay_domain text;
     edge_relay text;
     is_lan boolean;
 BEGIN
     SELECT s.host, s.tv_port, m.started_at, mo.tv_delay, m.id, sr.is_lan
     INTO server_host, tv_port, started_at, tv_delay, match_id, is_lan
     FROM matches m
        INNER JOIN servers s ON s.id = m.server_id
        INNER JOIN match_options mo on mo.id = m.match_options_id
        LEFT JOIN server_regions sr ON sr.value = s.region
     WHERE m.id = match.id
     LIMIT 1;

    IF server_host IS NULL OR started_at IS NULL OR NOW() < started_at + (tv_delay || ' seconds')::interval THEN
         RETURN NULL;
     END IF;

    password := player_match_password(match, 'tv', hasura_session);

    if(password is null) then
        return null;
    end if;
    
    relay_domain := get_setting('relay_domain', 'https://relay.5stack.gg');

    -- The edge worker only helps viewers out on the internet; a LAN server's
    -- viewers would be sent out to Cloudflare and back. Only a bare https
    -- origin is used, since it ends up in a command viewers paste into CS2.
    edge_relay := get_setting('playcast_relay_url', '');
    IF is_lan IS NOT TRUE AND edge_relay ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' THEN
        relay_domain := edge_relay;
    END IF;
    use_playcast := get_setting('use_playcast', 'false');

    if(use_playcast = 'true' and relay_domain is not null) then
        return CONCAT('playcast "', relay_domain, '/', match_id, '"');
    else
        return CONCAT('connect ', CONCAT(server_host, ':', tv_port), '; password ', password);
    end if;
 END;
 $$;