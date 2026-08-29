CREATE OR REPLACE FUNCTION public.tbi_tournament_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _session json;
BEGIN
    SELECT * INTO _tournament FROM public.tournaments t WHERE t.id = NEW.tournament_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    _session := nullif(current_setting('hasura.user', true), '')::json;

    -- A session with no role is an internal write and stays unrestricted, the
    -- same shape tbd_tournament_team uses; only a real request is gated.
    IF (_session ->> 'x-hasura-role') IS NOT NULL
       AND _tournament.invite_only
       AND NOT public.is_tournament_organizer(_tournament, _session)
       AND NOT public.tournament_registration_unlocked(
               NEW.tournament_id,
               nullif(_session ->> 'x-hasura-user-id', '')::bigint
           ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament is invite only';
    END IF;

    IF _tournament.registration_type = 'teams' THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'This tournament only accepts pre-formed teams';
    END IF;

    IF NOT public.player_meets_tournament_requirements(NEW.tournament_id, NEW.player_steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Player does not meet this tournament''s entry requirements';
    END IF;

    -- Registering after the window opened counts as present: nobody can confirm
    -- a prompt they were never shown, and the close pass waitlists no-shows.
    IF NEW.checked_in_at IS NULL AND public.tournament_check_in_open(_tournament) THEN
        NEW.checked_in_at = now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_free_agents ON public.tournament_free_agents;
CREATE TRIGGER tbi_tournament_free_agents
    BEFORE INSERT ON public.tournament_free_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_tournament_free_agents();
