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

    -- A team owner is already in the tournament. The draft makes its top-rated
    -- player the generated team's owner, and tournament_teams is
    -- UNIQUE (owner_steam_id, tournament_id), so letting an owner into the pool
    -- sets up a duplicate key that aborts the whole registration-close
    -- transition. The draft skips them too; this only refuses the join outright
    -- so the pool never shows a slot that could not be honoured.
    IF EXISTS (
        SELECT 1
        FROM public.tournament_teams tt
        WHERE tt.tournament_id = NEW.tournament_id
          AND tt.owner_steam_id = NEW.player_steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'You already have a team in this tournament';
    END IF;

    IF NOT public.tournament_free_agent_party_fits(NEW.tournament_id, NEW.party_id, NEW.id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'That party is already the size of a full team';
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

-- Only a party_id that actually MOVES is re-measured. The draft rewrites status
-- and tournament_team_id on every row it touches, and re-counting a party on
-- each of those is work that can never find anything: a party only grows on an
-- insert or on a row joining it.
CREATE OR REPLACE FUNCTION public.tbu_tournament_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.party_id IS NOT NULL
       AND NEW.party_id IS DISTINCT FROM OLD.party_id
       AND NOT public.tournament_free_agent_party_fits(NEW.tournament_id, NEW.party_id, NEW.id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'That party is already the size of a full team';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_tournament_free_agents ON public.tournament_free_agents;
CREATE TRIGGER tbu_tournament_free_agents
    BEFORE UPDATE ON public.tournament_free_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_tournament_free_agents();

-- A party of one is just a free agent. Left standing it shows the web a party
-- with nobody in it, and tells the last member they are still signed up "with"
-- someone who has gone.
CREATE OR REPLACE FUNCTION public.tadu_tournament_free_agents_party() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.party_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.party_id IS NOT DISTINCT FROM OLD.party_id THEN
        RETURN NULL;
    END IF;

    -- Drafted rows are left alone: after the draft the party_id is the record of
    -- who signed up with whom, not a queue position. Clearing the survivor's
    -- party_id re-enters this trigger with a party that no longer exists, where
    -- the count is 0 and nothing matches -- so it stops after one pass.
    UPDATE public.tournament_free_agents fa
       SET party_id = NULL
     WHERE fa.tournament_id = OLD.tournament_id
       AND fa.party_id = OLD.party_id
       AND fa.status IN ('registered', 'waitlisted')
       AND (
           SELECT COUNT(*)
             FROM public.tournament_free_agents other
            WHERE other.tournament_id = OLD.tournament_id
              AND other.party_id = OLD.party_id
              AND other.status <> 'withdrawn'
       ) = 1;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tadu_tournament_free_agents_party ON public.tournament_free_agents;
CREATE TRIGGER tadu_tournament_free_agents_party
    AFTER UPDATE OF party_id OR DELETE ON public.tournament_free_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.tadu_tournament_free_agents_party();

-- Leaving the pool has to give the slot up too. The roster row is what the
-- seeding, the lineups and the team page actually read, so a drafted agent who
-- deleted only their pool row stayed on the team while the waitlist behind them
-- never moved. Deleting it here is also what runs the promotion, via
-- tad_tournament_team_roster_free_agents below -- one path, not two.
CREATE OR REPLACE FUNCTION public.tad_tournament_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF OLD.status <> 'drafted' OR OLD.tournament_team_id IS NULL THEN
        RETURN OLD;
    END IF;

    -- The tournament itself is on its way out; the roster rows are cascading
    -- anyway and there is nothing left to promote into.
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = OLD.tournament_id) THEN
        RETURN OLD;
    END IF;

    DELETE FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_id = OLD.tournament_id
       AND ttr.player_steam_id = OLD.player_steam_id
       AND ttr.tournament_team_id = OLD.tournament_team_id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournament_free_agents ON public.tournament_free_agents;
CREATE TRIGGER tad_tournament_free_agents
    AFTER DELETE ON public.tournament_free_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_tournament_free_agents();

-- Lives with the free agents rather than in tournament_team_roster.sql because
-- it is entirely the pool's business: it exists so a vacated drafted slot is
-- refilled from the waitlist, whichever route emptied it -- the leave action,
-- an organizer removing the player, or a pool row deleted straight through
-- Hasura.
CREATE OR REPLACE FUNCTION public.tad_tournament_team_roster_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.tournament_free_agents fa
        WHERE fa.tournament_id = OLD.tournament_id
    ) THEN
        RETURN OLD;
    END IF;

    -- A pool row left pointing at a team the player is no longer on hides them
    -- from the waitlist and from the pool alike. Withdrawn, not waitlisted: they
    -- were removed from the tournament, not passed over by the draft.
    UPDATE public.tournament_free_agents fa
       SET status = 'withdrawn',
           tournament_team_id = NULL
     WHERE fa.tournament_id = OLD.tournament_id
       AND fa.player_steam_id = OLD.player_steam_id
       AND fa.status = 'drafted';

    PERFORM public.promote_tournament_free_agent(OLD.tournament_id, OLD.tournament_team_id);

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournament_team_roster_free_agents ON public.tournament_team_roster;
CREATE TRIGGER tad_tournament_team_roster_free_agents
    AFTER DELETE ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_tournament_team_roster_free_agents();
