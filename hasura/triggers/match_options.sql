CREATE OR REPLACE FUNCTION public.tbi_match_options() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
region_count int;
BEGIN
    select count(*) INTO region_count from e_game_server_node_regions gsr
        INNER JOIN game_server_nodes gsn on gsn.region = gsr.value and gsn.enabled = true 
        where gsn.region != 'Lan';

    IF region_count = 1 THEN
        NEW.region_veto = false;
    END IF;

	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_match_options ON public.match_options;
CREATE TRIGGER tbi_match_options BEFORE INSERT ON public.match_options FOR EACH ROW EXECUTE FUNCTION public.tbi_match_options();