-- tbi_tournament_team_roster's rule for bringing someone from outside an entry
-- onto it by invite. While a team-backed entry's team is short of players the
-- invite joins them to the team as well, so it also takes the right to invite
-- to that team.
CREATE OR REPLACE FUNCTION public.can_recruit_tournament_team_player(tournament_team public.tournament_teams, hasura_session json) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF NOT public.can_manage_tournament_team(tournament_team, hasura_session) THEN
        RETURN false;
    END IF;

    IF NOT public.tournament_team_invites_join_team(tournament_team) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.teams t
        WHERE t.id = tournament_team.team_id
          AND public.can_invite_to_team(t, hasura_session)
    );
END;
$$;
