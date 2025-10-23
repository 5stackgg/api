CREATE OR REPLACE FUNCTION public.tbu_match_lineups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    _match_status text;
BEGIN
    IF NEW.team_name != OLD.team_name  THEN
        select status from matches where lineup_1_id = NEW.id or lineup_2_id = NEW.id into _match_status;
        IF _match_status NOT IN ('PickingPlayers', 'Scheduled', 'WaitingForCheckIn', 'Veto', 'WaitingForServer') THEN
            RAISE EXCEPTION 'Cannot change the name of a lineup when the match is Live or Finished' USING ERRCODE = '22000';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_match_lineups ON public.match_lineups;
CREATE TRIGGER tbu_match_lineups BEFORE INSERT OR UPDATE ON public.match_lineups FOR EACH ROW EXECUTE FUNCTION public.tbu_match_lineups();
