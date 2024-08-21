CREATE OR REPLACE FUNCTION public.tbiu_team_invites() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM team_invite_check_for_existing_member(NEW);
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbiu_team_invites ON public.team_invites;
CREATE TRIGGER tbiu_team_invites BEFORE INSERT OR UPDATE ON public.team_invites FOR EACH ROW EXECUTE FUNCTION public.tbiu_team_invites();
