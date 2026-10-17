CREATE OR REPLACE FUNCTION public.tbiu_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    enc_secret text;
    disable_game_node_server_id uuid;
    node_sync boolean;
BEGIN
    enc_secret = current_setting('fivestack.app_key');

    -- Raised by taiud_populate_game_servers, populate_game_servers and
    -- tau_validate_lan_regions around their own writes: a dedicated server's
    -- host, region and ports follow its node, and nothing else may set them.
    node_sync = COALESCE(current_setting('fivestack.node_server_sync', true) = 'true', false);

    IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.game_server_node_id != OLD.game_server_node_id) THEN
        -- Set the region and host based on the assigned node and its LAN/public IP
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

        -- Find the lowest port non-dedicated (game node) server on this node to disable
        SELECT s.id, s.port, s.tv_port INTO disable_game_node_server_id, NEW.port, NEW.tv_port 
        FROM servers s
        WHERE 
            s.game_server_node_id = NEW.game_server_node_id 
            AND s.is_dedicated = false
            AND s.reserved_by_match_id IS NULL 
            AND s.enabled = true
            AND NOT EXISTS (
                SELECT 1 FROM servers s2 
                WHERE s2.game_server_node_id = NEW.game_server_node_id
                  AND s2.port = s.port
                  AND s2.tv_port = s.tv_port
                  AND s2.is_dedicated = true
            )
        ORDER BY s.port ASC LIMIT 1;

        -- Fail if no available server was found
        IF disable_game_node_server_id IS NULL THEN
            RAISE EXCEPTION 'No available game node server found on this node' USING ERRCODE = '22000';
        END IF;

        -- Take the selected game node server's slot; a disabled dedicated server leaves it usable, as toggling does
        UPDATE servers SET enabled = (NEW.enabled IS FALSE) where id = disable_game_node_server_id;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Prevent port/tv_port changes for dedicated servers; a move to another node takes that node's free slot above
        IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL
           AND NEW.game_server_node_id IS NOT DISTINCT FROM OLD.game_server_node_id
           AND (NEW.port != OLD.port OR NEW.tv_port != OLD.tv_port)
           AND NOT node_sync THEN
            RAISE EXCEPTION 'Cannot change the port or tv_port of a dedicated server' USING ERRCODE = '22000';
        END IF;

        -- Prevent removal of a game_server_node assignment
        IF OLD.game_server_node_id IS NOT NULL AND NEW.game_server_node_id IS NULL THEN
            RAISE EXCEPTION 'Cannot remove from a game server node' USING ERRCODE = '22000';
        END IF;

        -- If changing node assignment, revert prior server slot to enabled
        IF NEW.game_server_node_id != OLD.game_server_node_id THEN
            UPDATE servers SET enabled = true where port = OLD.port and tv_port = OLD.tv_port and game_server_node_id = OLD.game_server_node_id and id != OLD.id;
        END IF;
        
        -- Toggle the enabled state of the matching game node server based on the dedicated server's state
        IF NEW.is_dedicated = true AND NEW.game_server_node_id IS NOT NULL AND NEW.enabled != OLD.enabled THEN
            UPDATE servers
            SET enabled = NOT NEW.enabled
            WHERE port = NEW.port
              AND tv_port = NEW.tv_port
              AND game_server_node_id = NEW.game_server_node_id
              AND is_dedicated = false;
        END IF;

        -- If rcon_password changed, and it's not just re-using the encrypted value, encrypt it
        IF NEW.rcon_password != OLD.rcon_password AND NEW.rcon_password != pgp_sym_decrypt_bytea(OLD.rcon_password, enc_secret) THEN
           NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
        ELSE
            -- Otherwise, keep the old password (either not changed, or unchanged after re-encryption)
            NEW.rcon_password := OLD.rcon_password;
        END IF;

        -- Prevent changing the server type on game node servers (not dedicated)
        IF OLD.is_dedicated = false THEN
            IF NEW.type != OLD.type THEN
                RAISE EXCEPTION 'Cannot change the type of a game node server' USING ERRCODE = '22000';
            END IF;
        END IF;

        -- For dedicated servers, lock host and port/region assignments if staying on the same node
        IF NEW.is_dedicated = true AND NEW.game_server_node_id = OLD.game_server_node_id AND NOT node_sync THEN
            NEW.host = OLD.host;
            NEW.port = OLD.port;
            NEW.tv_port = OLD.tv_port;
            NEW.region = OLD.region;
        END IF;
    ELSE
        NEW.rcon_password := pgp_sym_encrypt_bytea(NEW.rcon_password, enc_secret);
    END IF;

    -- Prevent unassigned game node servers from being created
    IF NEW.is_dedicated = false AND NEW.game_server_node_id IS NULL THEN
        RAISE EXCEPTION 'Cannot assign a game node server without a node assigned' USING ERRCODE = '22000';
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiud_servers ON public.servers;
DROP FUNCTION IF EXISTS public.tbiud_servers();

DROP TRIGGER IF EXISTS tbiu_servers ON public.servers;
CREATE TRIGGER tbiu_servers BEFORE INSERT OR UPDATE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tbiu_servers();

-- Gives a deleted dedicated server's slot back to its on-demand server. It has
-- to run after the statement's deletes: one statement can delete both (a node
-- going away takes every server on it), and a row changed from a BEFORE trigger
-- can no longer be deleted by the statement that fired it.
CREATE OR REPLACE FUNCTION public.tad_servers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.is_dedicated = true AND OLD.game_server_node_id IS NOT NULL THEN
        UPDATE servers SET enabled = true where port = OLD.port and tv_port = OLD.tv_port and game_server_node_id = OLD.game_server_node_id and id != OLD.id and is_dedicated = false;
    END IF;

    RETURN NULL;
END;
$$;

-- A row's AFTER triggers fire in name order and the foreign keys' own are
-- RI_ConstraintTrigger_*, so the capital A puts this one ahead of them:
-- clearing matches.server_id re-checks the match's regions, which must already
-- count the slot as free.
DROP TRIGGER IF EXISTS "A_tad_servers" ON public.servers;
CREATE TRIGGER "A_tad_servers" AFTER DELETE ON public.servers FOR EACH ROW EXECUTE FUNCTION public.tad_servers();

DROP TRIGGER IF EXISTS "set_public_servers_updated_at" ON "public"."servers";
CREATE TRIGGER "set_public_servers_updated_at"
BEFORE UPDATE ON "public"."servers"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();

-- Runs after tbiu_servers, which can put back what a write asked for (host and
-- ports follow the node, an unchanged rcon password keeps its old ciphertext).
DROP TRIGGER IF EXISTS y_tbu_servers_last_changed_by ON public.servers;
CREATE TRIGGER y_tbu_servers_last_changed_by
    BEFORE UPDATE OF last_changed_by_steam_id ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.tbu_last_changed_by_named();

DROP TRIGGER IF EXISTS z_tbiu_servers_last_changed ON public.servers;
CREATE TRIGGER z_tbiu_servers_last_changed
    BEFORE INSERT OR UPDATE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.tbiu_stamp_last_changed(
        'access_min_role', 'access_restricted', 'connect_password', 'enabled',
        'featured', 'game', 'game_mode_id', 'game_server_node_id', 'host',
        'is_dedicated', 'label', 'map_rotation_shuffle', 'max_players', 'port',
        'rcon_password', 'region', 'tv_port', 'type'
    );
