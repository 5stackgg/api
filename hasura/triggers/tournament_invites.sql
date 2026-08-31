CREATE OR REPLACE FUNCTION public.tbi_tournament_invites() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _session json;
BEGIN
    SELECT * INTO _tournament
    FROM public.tournaments
    WHERE id = NEW.tournament_id;

    _session := nullif(current_setting('hasura.user', true), '')::json;

    -- A session with no role is an internal write (a cascade, a job, the accept
    -- action) and stays unrestricted, the same shape tbi_tournament_team uses.
    -- Only a real request is gated.
    --
    -- The metadata insert rule says the same thing for the GraphQL path, but
    -- what an accepted invite writes is a tournament_registration_unlocks row,
    -- which IS the invite-only gate -- worth stating once more where no path
    -- can route around it.
    IF (_session ->> 'x-hasura-role') IS NOT NULL THEN
        IF NOT public.is_tournament_organizer(_tournament, _session) THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'Only a tournament organizer can invite players';
        END IF;

        -- Deliberately not conditioned on invite_only: that governs who may
        -- ENTER, not whether an organizer may recruit, so inviting works in
        -- either state. What it is conditioned on is the registration window --
        -- the same one the invite links use -- because past it there is nothing
        -- to invite anybody into. An accepted invite writes a registration
        -- unlock, and the bracket has already been drawn off the teams that
        -- registered.
        IF _tournament.status NOT IN ('Setup', 'RegistrationOpen') THEN
            RAISE EXCEPTION USING ERRCODE = '22000',
                MESSAGE = 'Registration is closed';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_invites ON public.tournament_invites;
CREATE TRIGGER tbi_tournament_invites BEFORE INSERT ON public.tournament_invites FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_invites();
