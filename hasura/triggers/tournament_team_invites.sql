CREATE OR REPLACE FUNCTION public.tbi_tournament_team_invites() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_not_blocked(NEW.invited_by_player_steam_id, NEW.steam_id);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_tournament_team_invites ON public.tournament_team_invites;
CREATE TRIGGER tbi_tournament_team_invites BEFORE INSERT ON public.tournament_team_invites FOR EACH ROW EXECUTE FUNCTION public.tbi_tournament_team_invites();
