CREATE OR REPLACE FUNCTION public.tai_match_map_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM create_match_map_from_veto(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_map_veto_picks ON public.match_map_veto_picks;
CREATE TRIGGER tai_match_map_veto_picks AFTER INSERT ON public.match_map_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tai_match_map_veto_picks();

CREATE OR REPLACE FUNCTION public.tbd_match_map_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM match_maps WHERE map_id = OLD.map_id AND match_id = OLD.match_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_match_map_veto_picks ON public.match_map_veto_picks;
CREATE TRIGGER tbd_match_map_veto_picks BEFORE DELETE ON public.match_map_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbd_match_map_veto_picks();

CREATE OR REPLACE FUNCTION public.tbiu_match_map_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM verify_map_veto_pick(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_match_map_veto_picks ON public.match_map_veto_picks;
CREATE TRIGGER tbiu_match_map_veto_picks BEFORE INSERT OR UPDATE ON public.match_map_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbiu_match_map_veto_picks();
