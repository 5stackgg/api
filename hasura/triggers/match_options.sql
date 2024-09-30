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
    select count(*) INTO region_count from e_game_server_node_regions gsr
        INNER JOIN game_server_nodes gsn on gsn.region = gsr.value and gsn.enabled = true 
        where gsn.region != 'Lan';

    IF region_count = 1 THEN
        NEW.region_veto = false;
    END IF;

    IF NEW.lan = true THEN
        NEW.region_veto = false;

        SELECT COUNT(*) INTO lan_count FROM game_server_nodes
        WHERE region = 'Lan' AND enabled = true;

        IF lan_count = 0 THEN
            RAISE EXCEPTION 'No enabled LAN servers available' USING ERRCODE = '22000';
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
    IF NEW.lan THEN
        UPDATE matches SET region = 'Lan' WHERE match_options_id = NEW.id;
    END IF;


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
    IF NEW.lan THEN
        UPDATE matches SET region = 'Lan' WHERE match_options_id = NEW.id;
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

DROP TRIGGER IF EXISTS tbu_match_options ON public.match_options;
CREATE TRIGGER tbu_match_options BEFORE UPDATE ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tbu_match_options();