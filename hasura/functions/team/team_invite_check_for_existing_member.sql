CREATE OR REPLACE FUNCTION public.team_invite_check_for_existing_member(team_invite team_invites) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
BEGIN
	 IF EXISTS (SELECT 1 FROM team_roster WHERE team_id = team_invite.team_id AND player_steam_id = team_invite.steam_id) THEN
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Player already on team.';
    END IF;
END;
$$;