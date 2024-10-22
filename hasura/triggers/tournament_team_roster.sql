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