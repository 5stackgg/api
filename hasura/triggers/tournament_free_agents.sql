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

    -- Taken by every write that puts a player into a tournament, so a pool
    -- sign-up and a team join for the same player cannot both miss the other's
    -- uncommitted row and leave them in twice.
    PERFORM pg_advisory_xact_lock(
        hashtext('tournament_entry'),
        hashtext(NEW.tournament_id::text || ':' || NEW.player_steam_id::text)
    );

    IF NOT public.player_meets_tournament_requirements(NEW.tournament_id, NEW.player_steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Player does not meet this tournament''s entry requirements';
    END IF;

    -- A team owner or a rostered player is already in the tournament. The draft
    -- skips them too; this only refuses the join outright so the pool never
    -- shows a slot that could not be honoured. The reverse order -- pool first,
    -- team second -- is tai_tournament_team_roster_free_agents below.
    IF EXISTS (
        SELECT 1
        FROM public.tournament_teams tt
        WHERE tt.tournament_id = NEW.tournament_id
          AND tt.owner_steam_id = NEW.player_steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'You already have a team in this tournament';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.tournament_team_roster ttr
        WHERE ttr.tournament_id = NEW.tournament_id
          AND ttr.player_steam_id = NEW.player_steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'You are already on a team in this tournament';
    END IF;

    -- The draft runs once (it is idempotent on is_drafted), so a sign-up that
    -- lands after it would sit as 'registered' waiting on a draft that never
    -- comes. The waitlist is where everyone the draft did not place waits, in
    -- sign-up order, and tai_tournament_free_agents fills an open slot from it.
    IF NEW.status = 'registered' AND EXISTS (
        SELECT 1
        FROM public.tournament_teams tt
        WHERE tt.tournament_id = NEW.tournament_id
          AND tt.is_drafted
    ) THEN
        NEW.status = 'waitlisted';
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

-- A slot given up while the waitlist was empty stays open until someone joins
-- it; promotion otherwise only runs when a roster row is deleted, so the late
-- sign-up would wait behind a vacancy nobody was ever going to fill.
CREATE OR REPLACE FUNCTION public.tai_tournament_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
BEGIN
    IF NEW.status <> 'waitlisted' THEN
        RETURN NULL;
    END IF;

    FOR _team_id IN
        SELECT tt.id
          FROM public.tournament_teams tt
         WHERE tt.tournament_id = NEW.tournament_id
           AND tt.is_drafted
         ORDER BY tt.name, tt.id
    LOOP
        PERFORM public.promote_tournament_free_agent(NEW.tournament_id, _team_id);
    END LOOP;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_free_agents ON public.tournament_free_agents;
CREATE TRIGGER tai_tournament_free_agents
    AFTER INSERT ON public.tournament_free_agents
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_tournament_free_agents();

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
DECLARE
    _team public.tournament_teams;
    _status text;
    _heir bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.tournament_free_agents fa
        WHERE fa.tournament_id = OLD.tournament_id
    ) THEN
        -- A pool row left pointing at a team the player is no longer on hides
        -- them from the waitlist and from the pool alike. Withdrawn, not
        -- waitlisted: they were removed from the tournament, not passed over by
        -- the draft.
        UPDATE public.tournament_free_agents fa
           SET status = 'withdrawn',
               tournament_team_id = NULL
         WHERE fa.tournament_id = OLD.tournament_id
           AND fa.player_steam_id = OLD.player_steam_id
           AND fa.status = 'drafted';

        PERFORM public.promote_tournament_free_agent(OLD.tournament_id, OLD.tournament_team_id);
    END IF;

    -- Outside the pool check: the leave action deletes the pool row before the
    -- roster row, so the last drafted player out finds the pool already empty.
    SELECT tt.* INTO _team
      FROM public.tournament_teams tt
     WHERE tt.id = OLD.tournament_team_id
       AND tt.is_drafted;

    IF NOT FOUND
       OR (OLD.player_steam_id IS DISTINCT FROM _team.owner_steam_id
           AND OLD.player_steam_id IS DISTINCT FROM _team.captain_steam_id) THEN
        RETURN OLD;
    END IF;

    -- A pickup team's owner is only the draft's stand-in for the NOT NULL
    -- owner/captain columns. Left pointing at the player who just left, they
    -- keep "owning" a team they are not on: shut out of the pool they left
    -- for, while the team is captained by nobody on it. The draft's own rule
    -- picks the replacement.
    SELECT ttr.player_steam_id INTO _heir
      FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_team_id = _team.id
     ORDER BY COALESCE(public.get_tournament_player_elo(_team.tournament_id, ttr.player_steam_id), 5000) DESC,
              ttr.player_steam_id
     LIMIT 1;

    IF _heir IS NOT NULL THEN
        UPDATE public.tournament_teams tt
           SET owner_steam_id = CASE WHEN tt.owner_steam_id = OLD.player_steam_id THEN _heir ELSE tt.owner_steam_id END,
               captain_steam_id = CASE WHEN tt.captain_steam_id = OLD.player_steam_id THEN _heir ELSE tt.captain_steam_id END
         WHERE tt.id = _team.id;

        UPDATE public.tournament_team_roster ttr
           SET role = 'Admin'
         WHERE ttr.tournament_team_id = _team.id
           AND ttr.player_steam_id = _heir
           AND _team.owner_steam_id = OLD.player_steam_id;

        RETURN OLD;
    END IF;

    -- Nobody left and nobody on the waitlist to refill it: a pickup team with
    -- no players is not a team. Only while the bracket is undrawn -- the roster
    -- lock already stops a seeded team from emptying, and tbd_tournament_team
    -- refuses the delete once the tournament is over.
    SELECT t.status INTO _status FROM public.tournaments t WHERE t.id = _team.tournament_id;

    IF _status IN ('Setup', 'RegistrationOpen', 'CheckInReview') THEN
        DELETE FROM public.tournament_teams tt WHERE tt.id = _team.id;
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_tournament_team_roster_free_agents ON public.tournament_team_roster;
CREATE TRIGGER tad_tournament_team_roster_free_agents
    AFTER DELETE ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_tournament_team_roster_free_agents();

-- Joining a team is leaving the pool, whichever route the roster row came in
-- by: an accepted invite, a captain or organizer adding them, or a 5stack team
-- registering with them on it. Left behind, the pool row reads as a second
-- entry -- counted in the pool, offered check-in twice, and held for a
-- promotion the draft would only skip.
--
-- The draft and the waitlist promotion write roster rows for pool members on
-- purpose; the GUC they set marks those.
CREATE OR REPLACE FUNCTION public.tai_tournament_team_roster_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF current_setting('fivestack.free_agent_draft', true) = 'true' THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtext('tournament_entry'),
        hashtext(NEW.tournament_id::text || ':' || NEW.player_steam_id::text)
    );

    -- Placed by hand on a pickup team, they are drafted onto it rather than
    -- gone: the pool row is what the drafted-team view and the leave action
    -- read for a pickup player.
    IF EXISTS (
        SELECT 1
        FROM public.tournament_teams tt
        WHERE tt.id = NEW.tournament_team_id
          AND tt.is_drafted
    ) THEN
        UPDATE public.tournament_free_agents fa
           SET status = 'drafted',
               tournament_team_id = NEW.tournament_team_id
         WHERE fa.tournament_id = NEW.tournament_id
           AND fa.player_steam_id = NEW.player_steam_id
           AND fa.status IN ('registered', 'waitlisted');

        RETURN NULL;
    END IF;

    DELETE FROM public.tournament_free_agents fa
     WHERE fa.tournament_id = NEW.tournament_id
       AND fa.player_steam_id = NEW.player_steam_id
       AND fa.status IN ('registered', 'waitlisted');

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_team_roster_free_agents ON public.tournament_team_roster;
CREATE TRIGGER tai_tournament_team_roster_free_agents
    AFTER INSERT ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_tournament_team_roster_free_agents();

-- The same for registering a team: owning one is being in the tournament, even
-- for an owner who is not on its roster.
CREATE OR REPLACE FUNCTION public.tai_tournament_teams_free_agents() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.is_drafted THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtext('tournament_entry'),
        hashtext(NEW.tournament_id::text || ':' || NEW.owner_steam_id::text)
    );

    DELETE FROM public.tournament_free_agents fa
     WHERE fa.tournament_id = NEW.tournament_id
       AND fa.player_steam_id = NEW.owner_steam_id
       AND fa.status IN ('registered', 'waitlisted');

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tai_tournament_teams_free_agents ON public.tournament_teams;
CREATE TRIGGER tai_tournament_teams_free_agents
    AFTER INSERT ON public.tournament_teams
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_tournament_teams_free_agents();
