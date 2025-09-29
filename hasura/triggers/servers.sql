CREATE OR REPLACE FUNCTION public.tbiud_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    enc_secret text;
    delete_server_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.is_dedicated = true AND OLD.game_server_node_id IS NOT NULL THEN
            UPDATE servers SET enabled = true where port = OLD.port and tv_port = OLD.tv_port and game_server_node_id = OLD.game_server_node_id and id != OLD.id;
        END IF;

        RETURN OLD;
    END IF;

    enc_secret = current_setting('fivestack.app_key');

    IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.game_server_node_id != OLD.game_server_node_id) THEN
        SELECT 
            gsn.region, 
            CASE 
                WHEN sr.is_lan = true THEN host(gsn.lan_ip)
                ELSE host(gsn.public_ip)
            END
        INTO NEW.region, NEW.host 
        FROM game_server_nodes gsn
        JOIN server_regions sr ON sr.value = gsn.region
        WHERE gsn.id = NEW.game_server_node_id;

        SELECT id, port, tv_port INTO delete_server_id, NEW.port, NEW.tv_port FROM servers 
        WHERE 
            game_server_node_id = NEW.game_server_node_id 
            AND is_dedicated = false
            AND reserved_by_match_id IS NULL 
            AND enabled = true
        ORDER BY port ASC LIMIT 1;

        UPDATE servers SET enabled = false where id = delete_server_id;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL AND (NEW.port != OLD.port OR NEW.tv_port != OLD.tv_port) THEN
            RAISE EXCEPTION 'Cannot change the port or tv_port of a dedicated server' USING ERRCODE = '22000';
        END IF;

        IF OLD.game_server_node_id IS NOT NULL AND NEW.game_server_node_id IS NULL THEN
            RAISE EXCEPTION 'Cannot remove from a game server node' USING ERRCODE = '22000';
        END IF;

        IF NEW.game_server_node_id != OLD.game_server_node_id THEN
            UPDATE servers SET enabled = true where port = OLD.port and tv_port = OLD.tv_port and game_server_node_id = OLD.game_server_node_id and id != OLD.id;
        END IF;
        
        IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL AND NEW.enabled != OLD.enabled THEN
            UPDATE servers
            SET enabled = NOT NEW.enabled
            WHERE port = NEW.port
              AND tv_port = NEW.tv_port
              AND game_server_node_id = NEW.game_server_node_id
              AND id != NEW.id;
        END IF;

        IF NEW.rcon_password != OLD.rcon_password AND NEW.rcon_password != pgp_sym_decrypt_bytea(OLD.rcon_password, enc_secret) THEN
           NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
        ELSE
            NEW.rcon_password := OLD.rcon_password;
        END IF;

        IF OLD.is_dedicated = false THEN
            IF NEW.type != OLD.type THEN
                RAISE EXCEPTION 'Cannot change the type of a game node server' USING ERRCODE = '22000';
            END IF;
        END IF;

        IF NEW.is_dedicated = true AND NEW.game_server_node_id = OLD.game_server_node_id THEN
            NEW.host = OLD.host;
            NEW.port = OLD.port;
            NEW.tv_port = OLD.tv_port;
            NEW.region = OLD.region;
        END IF;
    ELSE
        NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
    END IF;

    IF NEW.is_dedicated = false AND NEW.game_server_node_id IS NULL THEN
        RAISE EXCEPTION 'Cannot assign a game node server without a node assigned' USING ERRCODE = '22000';
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_servers ON public.servers;

DROP TRIGGER IF EXISTS tbiud_servers ON public.servers;
CREATE TRIGGER tbiud_servers BEFORE INSERT OR UPDATE OR DELETE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiud_servers();