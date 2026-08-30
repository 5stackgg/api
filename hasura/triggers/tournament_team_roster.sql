CREATE OR REPLACE FUNCTION public.taiud_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM check_team_eligibility(OLD);
    ELSE
        PERFORM check_team_eligibility(NEW);
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiud_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER taiud_tournament_team_roster AFTER INSERT OR UPDATE OR DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.taiud_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbd_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _min_players int;
    _roster_count int;
BEGIN
    SELECT t.* INTO _tournament
        FROM tournament_teams tt
        JOIN tournaments t ON t.id = tt.tournament_id
        WHERE tt.id = OLD.tournament_team_id;

    -- When the whole team (or the tournament) is being deleted its
    -- tournament_teams row is already gone by the time this cascade fires, so
    -- the join finds nothing and we let the roster rows cascade through.
    IF NOT FOUND THEN
        RETURN OLD;
    END IF;

    -- Rosters are only locked once the bracket has been seeded. Before that
    -- (Setup / RegistrationOpen) teams edit their lineup freely and dropping
    -- below the minimum just makes them ineligible.
    IF _tournament.status NOT IN ('RegistrationClosed', 'Live', 'Paused') THEN
        RETURN OLD;
    END IF;

    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _roster_count
        FROM tournament_team_roster ttr
        WHERE ttr.tournament_team_id = OLD.tournament_team_id;

    -- Removing this player would strip the team's eligibility and seed while the
    -- tournament is underway. A team can only swap a player out if it has a
    -- substitute keeping it at or above the minimum lineup.
    IF _roster_count - 1 < _min_players THEN
        RAISE EXCEPTION USING
            ERRCODE = '22000',
            MESSAGE = 'Cannot remove player: the team would drop below the minimum lineup of ' || _min_players || ' players while the tournament is underway';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbd_tournament_team_roster BEFORE DELETE ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbd_tournament_team_roster();


CREATE OR REPLACE FUNCTION public.tbi_tournament_team_roster() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _team_id uuid;
    _owner_steam_id bigint;
BEGIN
    -- draft_tournament_free_agent_teams builds pickup teams out of players who
    -- never invited each other, so the invite redirect below would turn every
    -- generated roster row into an invitation nobody sent and leave the teams
    -- empty. The named GUC marks that system path the same way
    -- fivestack.league_cascade does, and is checked before hasura.user is read
    -- so the draft also works from a jobs/cron connection with no session.
    IF current_setting('fivestack.free_agent_draft', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF current_setting('hasura.user')::jsonb ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer') THEN
        RETURN NEW;
    END IF;

    -- Gates the player being ADDED, not the session adding them: a captain
    -- fills a roster with other people, so checking only the actor lets any of
    -- them past the tournament's role and ELO limits.
    IF NOT public.player_meets_tournament_requirements(NEW.tournament_id, NEW.player_steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Player does not meet this tournament''s entry requirements';
    END IF;

    SELECT team_id, owner_steam_id INTO _team_id, _owner_steam_id FROM tournament_teams WHERE id = NEW.tournament_team_id;

    IF _team_id IS NULL THEN
        IF _owner_steam_id = NEW.player_steam_id THEN 
            NEW.role = 'Admin';
            RETURN NEW;
        END IF;

        INSERT INTO tournament_team_invites (tournament_team_id, steam_id, invited_by_player_steam_id)
            VALUES (NEW.tournament_team_id, NEW.player_steam_id, (current_setting('hasura.user')::jsonb->>'x-hasura-user-id')::bigint);

        RETURN NULL;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_roster ON public.tournament_team_roster;
CREATE TRIGGER tbi_tournament_team_roster BEFORE INSERT ON public.tournament_team_roster FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_roster();

CREATE OR REPLACE FUNCTION public.taiu_tournament_team_roster_check_in() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    _tournament public.tournaments;
    _min_players int;
    _checked_in int;
BEGIN
    -- Only a real change to this player's own confirmation can move the team's
    -- rollup. Recomputing on every roster write would let adding a substitute
    -- wipe a checked-in (or organizer re-admitted) team.
    IF TG_OP = 'UPDATE' AND NEW.checked_in_at IS NOT DISTINCT FROM OLD.checked_in_at THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' AND NEW.checked_in_at IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.* INTO _tournament
      FROM public.tournaments t
     WHERE t.id = NEW.tournament_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Captains and Admin modes stamp tournament_teams.checked_in_at directly;
    -- per-player rows carry no authority there.
    IF NOT _tournament.check_in_required OR _tournament.check_in_setting <> 'Players' THEN
        RETURN NEW;
    END IF;

    -- The bar is the MINIMUM LINEUP, not the whole roster: a roster of seven
    -- (five starters plus two substitutes) only fields five, and a substitute
    -- who is not playing must not be able to hold the team out of the bracket.
    _min_players := tournament_min_players_per_lineup(_tournament);

    SELECT COUNT(*) INTO _checked_in
      FROM public.tournament_team_roster ttr
     WHERE ttr.tournament_team_id = NEW.tournament_team_id
       AND ttr.checked_in_at IS NOT NULL;

    IF _checked_in >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = now()
         WHERE tt.id = NEW.tournament_team_id
           AND tt.checked_in_at IS NULL;

    -- Clearing is only ever a WITHDRAWN confirmation breaking a roll-up that
    -- was already satisfied -- this row went from stamped to NULL, so the count
    -- was _checked_in + 1 a moment ago. A player CHECKING IN can only raise the
    -- count, and reacting to that would let the first player to confirm wipe a
    -- team the registration auto-stamp or an organizer re-admit had already
    -- checked in: they would harm their own team by doing what the UI asked.
    ELSIF NEW.checked_in_at IS NULL AND _checked_in + 1 >= _min_players THEN
        UPDATE public.tournament_teams tt
           SET checked_in_at = NULL
         WHERE tt.id = NEW.tournament_team_id
           AND tt.checked_in_at IS NOT NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS taiu_tournament_team_roster_check_in ON public.tournament_team_roster;
CREATE TRIGGER taiu_tournament_team_roster_check_in
    AFTER INSERT OR UPDATE OF checked_in_at ON public.tournament_team_roster
    FOR EACH ROW
    EXECUTE FUNCTION public.taiu_tournament_team_roster_check_in();
