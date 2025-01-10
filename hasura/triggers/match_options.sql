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
        FROM servers;

    IF region_count = 1 THEN
        NEW.region_veto = false;
    END IF;

    IF NEW.region_veto = false AND (NEW.regions IS NULL OR NEW.regions = '{}') THEN
        RAISE EXCEPTION 'Region veto is disabled but no regions are selected' USING ERRCODE = '22000';
    END IF;

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
BEGIN
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

DROP TRIGGER IF EXISTS tbu_match_options ON public.match_options;
CREATE TRIGGER tbu_match_options BEFORE UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tbu_match_options();