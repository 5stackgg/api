CREATE OR REPLACE FUNCTION public.tai_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM add_owner_to_team(NEW);
    UPDATE teams
    SET captain_steam_id = NEW.owner_steam_id
    WHERE id = NEW.id
      AND captain_steam_id IS NULL;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_teams ON public.teams;
CREATE TRIGGER tai_teams AFTER INSERT ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tai_teams();

CREATE OR REPLACE FUNCTION public.tbu_teams() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.captain_steam_id IS NOT NULL
        AND NEW.captain_steam_id IS DISTINCT FROM OLD.captain_steam_id
        AND NOT EXISTS (
            SELECT 1
            FROM team_roster tr
            WHERE tr.team_id = NEW.id
              AND tr.player_steam_id = NEW.captain_steam_id
        ) THEN
        RAISE EXCEPTION 'Team captain must be a team member' USING ERRCODE = '22000';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_teams ON public.teams;
CREATE TRIGGER tbu_teams BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.tbu_teams();
