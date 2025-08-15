CREATE OR REPLACE FUNCTION public.generate_invite_code() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    code text;
BEGIN
    code := lpad(cast(floor(random() * 1000000) as text), 6, '0');
    RETURN code;
END;
$$;


CREATE OR REPLACE FUNCTION public.tbi_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
lan_count int;
region_count int;
BEGIN
    SELECT COUNT(DISTINCT region) INTO region_count
        FROM servers where enabled = true;

    IF NEW.regions IS NOT NULL THEN
        SELECT count(*) INTO lan_count 
        FROM server_regions 
        WHERE value = ANY(NEW.regions) AND is_lan = true;

        IF lan_count > 0 THEN
            IF (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text = 'user' THEN
                RAISE EXCEPTION 'Cannot assign the Lan region' USING ERRCODE = '22000';
            END IF;
        END IF;
    END IF;

    IF region_count = 1 THEN
        NEW.region_veto = false;
        NEW.regions = (SELECT array_agg(region) FROM servers where enabled = true);
    END IF;

    IF EXISTS (SELECT 1 FROM tournaments WHERE match_options_id = NEW.id) AND NEW.lobby_access != 'Private' THEN 
        RAISE EXCEPTION 'Tournament matches can only have Private lobby access' USING ERRCODE = '22000';
    END IF;

    IF NEW.lobby_access = 'Invite' AND NEW.invite_code IS NULL THEN
        NEW.invite_code := generate_invite_code();
    ELSIF NEW.lobby_access != 'Invite' THEN 
        NEW.invite_code := NULL;
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match_options ON public.match_options;
CREATE TRIGGER tbi_match_options BEFORE INSERT ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tbi_match_options();


CREATE OR REPLACE FUNCTION public.tau_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM tournaments WHERE match_options_id = NEW.id) AND NEW.lobby_access != 'Private' THEN 
        RAISE EXCEPTION 'Tournament matches can only have Private lobby access' USING ERRCODE = '22000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_options ON public.match_options;
CREATE TRIGGER tau_match_options AFTER UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tau_match_options();

CREATE OR REPLACE FUNCTION public.tbu_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_status text;
BEGIN
    SELECT m.status INTO _match_status
        FROM matches m
        INNER JOIN match_options mo ON mo.id = m.match_options_id
        WHERE mo.id = OLD.id
        LIMIT 1;
    
    IF _match_status = 'Live' OR _match_status = 'Veto' OR _match_status = 'Finished' OR _match_status = 'Forfeit' OR _match_status = 'Tie' OR _match_status = 'Surrendered' THEN  
        RAISE EXCEPTION 'Cannot change match options after match goes live' USING ERRCODE = '22000';
    END IF;

    IF EXISTS (SELECT 1 FROM tournaments WHERE match_options_id = NEW.id) AND NEW.lobby_access != 'Private' THEN 
        RAISE EXCEPTION 'Tournament matches can only have Private lobby access' USING ERRCODE = '22000';
    END IF;

    IF NEW.lobby_access = 'Invite' AND NEW.invite_code IS NULL THEN
        NEW.invite_code := generate_invite_code();
    ELSIF NEW.lobby_access != 'Invite' THEN 
        NEW.invite_code := NULL;
    END IF;

    -- TODO : protect things that cannot be changed after match goes live

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_options ON public.match_options;
CREATE TRIGGER tbu_match_options BEFORE UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tbu_match_options();


CREATE OR REPLACE FUNCTION public.tau_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _match_id UUID;
    _map_ids UUID[];
    _match_maps UUID[];
BEGIN
    SELECT m.id INTO _match_id
        FROM matches m
        INNER JOIN match_options mo ON mo.id = m.match_options_id
        WHERE mo.id = OLD.id
        LIMIT 1;

    SELECT array_agg(map_id ORDER BY "order") INTO _match_maps FROM match_maps WHERE match_id = _match_id;
    SELECT array_agg(map_id ORDER BY map_id) INTO _map_ids FROM _map_pool WHERE map_pool_id = NEW.map_pool_id;

    IF (_match_maps IS NULL OR _match_maps IS DISTINCT FROM _map_ids OR NEW.map_pool_id != OLD.map_pool_id) THEN
        DELETE FROM match_maps
        WHERE match_id = _match_id;

        PERFORM setup_match_maps(_match_id, NEW.id);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tau_match_options ON public.match_options;
CREATE TRIGGER tau_match_options AFTER UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tau_match_options();