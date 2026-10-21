-- Whether someone from outside a team-backed entry's team also joins the team
-- when they accept an invite onto its lineup: only while the team has fewer
-- players than a lineup needs. A team that already has them takes outsiders as
-- stand-ins for this tournament alone.
CREATE OR REPLACE FUNCTION public.tournament_team_invites_join_team(tournament_team public.tournament_teams) RETURNS BOOLEAN
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    IF tournament_team.team_id IS NULL THEN
        RETURN false;
    END IF;

    RETURN (
        SELECT count(*)
        FROM public.team_roster tr
        WHERE tr.team_id = tournament_team.team_id
          AND NOT tr.coach
    ) < (
        SELECT public.tournament_min_players_per_lineup(t)
        FROM public.tournaments t
        WHERE t.id = tournament_team.tournament_id
    );
END;
$$;
