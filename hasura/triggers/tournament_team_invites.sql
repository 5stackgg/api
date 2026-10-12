CREATE OR REPLACE FUNCTION public.tbi_tournament_team_invites() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_not_blocked(NEW.invited_by_player_steam_id, NEW.steam_id);

    IF EXISTS (
        SELECT 1
          FROM tournament_teams tt
          JOIN tournament_team_roster ttr ON ttr.tournament_id = tt.tournament_id
         WHERE tt.id = NEW.tournament_team_id
           AND ttr.player_steam_id = NEW.steam_id
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Player is already on a team in this tournament';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_invites ON public.tournament_team_invites;
CREATE TRIGGER tbi_tournament_team_invites BEFORE INSERT ON public.tournament_team_invites FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_invites();
