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
    IF current_setting('hasura.user')::jsonb ->> 'x-hasura-role' IN ('admin', 'administrator', 'tournament_organizer') THEN
        RETURN NEW;
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