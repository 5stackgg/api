-- Backs the Hasura permission on tournament_organizers and
-- tournament_organizer_teams. A cascade (a deleted tournament, team or player)
-- is the database's own write, made from its foreign-key triggers, and passes.
CREATE OR REPLACE FUNCTION public.tbid_tournament_organizers() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _session json := nullif(current_setting('hasura.user', true), '')::json;
    _tournament_id uuid;
    _tournament public.tournaments;
BEGIN
    IF TG_OP = 'DELETE' THEN
        _tournament_id := OLD.tournament_id;
    ELSE
        _tournament_id := NEW.tournament_id;
    END IF;

    IF pg_trigger_depth() = 1 AND _session ->> 'x-hasura-role' IS NOT NULL THEN
        SELECT * INTO _tournament
        FROM public.tournaments
        WHERE id = _tournament_id;

        IF FOUND AND NOT public.can_manage_tournament_organizers(_tournament, _session) THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'Only the tournament''s organizers can change who organizes it';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbid_tournament_organizers ON public.tournament_organizers;
CREATE TRIGGER tbid_tournament_organizers
    BEFORE INSERT OR DELETE ON public.tournament_organizers
    FOR EACH ROW
    EXECUTE FUNCTION public.tbid_tournament_organizers();

DROP TRIGGER IF EXISTS tbid_tournament_organizer_teams ON public.tournament_organizer_teams;
CREATE TRIGGER tbid_tournament_organizer_teams
    BEFORE INSERT OR DELETE ON public.tournament_organizer_teams
    FOR EACH ROW
    EXECUTE FUNCTION public.tbid_tournament_organizers();
