CREATE OR REPLACE FUNCTION public.tai_match_region_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM auto_select_region_veto(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_match_region_veto_picks ON public.match_region_veto_picks;
CREATE TRIGGER tai_match_region_veto_picks AFTER INSERT ON public.match_region_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tai_match_region_veto_picks();


CREATE OR REPLACE FUNCTION public.tbiu_match_region_veto_picks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM verify_region_veto_pick(NEW);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_match_region_veto_picks ON public.match_region_veto_picks;
CREATE TRIGGER tbiu_match_region_veto_picks BEFORE INSERT OR UPDATE ON public.match_region_veto_picks FOR EACH ROW EXECUTE FUNCTION public.tbiu_match_region_veto_picks();
