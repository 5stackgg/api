CREATE OR REPLACE FUNCTION public.tbiu_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    enc_secret text;
    delete_server_id uuid;
BEGIN
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

        SELECT id, port, tv_port INTO delete_server_id, NEW.port, NEW.tv_port FROM servers WHERE game_server_node_id = NEW.game_server_node_id AND reserved_by_match_id IS NULL ORDER BY port ASC LIMIT 1;

        DELETE FROM servers WHERE id = delete_server_id;
    END IF;

    IF TG_OP = 'UPDATE' THEN
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
CREATE TRIGGER tbiu_servers BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_servers();