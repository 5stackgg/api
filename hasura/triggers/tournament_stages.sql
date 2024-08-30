CREATE OR REPLACE FUNCTION public.taiu_tournament_stages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 'ALTER TABLE public.tournament_stages DISABLE TRIGGER tbu_tournament_stages';

    BEGIN
        PERFORM update_tournament_stages(NEW.tournament_id);
    EXCEPTION
        WHEN OTHERS THEN
            PERFORM 'ALTER TABLE public.tournament_stages ENABLE TRIGGER tbu_tournament_stages';
            RAISE;
    END;

    PERFORM 'ALTER TABLE public.tournament_stages ENABLE TRIGGER tbu_tournament_stages';

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS taiu_tournament_stages ON public.tournament_stages;
CREATE TRIGGER taiu_tournament_stages AFTER INSERT OR UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.taiu_tournament_stages();

CREATE OR REPLACE FUNCTION public.tbu_tournament_stages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tournament_status text;
BEGIN
    SELECT status
    INTO tournament_status
    FROM tournaments t
    WHERE t.id = NEW.tournament_id;

    IF tournament_status != 'Setup' THEN
        RAISE EXCEPTION 'Unable to modify stage since the tournament has been started';
    END IF;

    RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS tbu_tournament_stages ON public.tournaments;
CREATE TRIGGER tbu_tournament_stages BEFORE UPDATE ON public.tournament_stages FOR EACH ROW EXECUTE FUNCTION public.tbu_tournament_stages();

