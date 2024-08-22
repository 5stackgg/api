CREATE OR REPLACE FUNCTION public.check_team_eligibility(roster tournament_team_roster) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    roster_count INT;
    tournament_type TEXT;
    min_players INT;
BEGIN
    SELECT COUNT(ttr.*) INTO roster_count
        FROM tournament_teams tt
        INNER JOIN tournament_team_roster ttr ON ttr.tournament_team_id = tt.id
        WHERE tt.id = roster.tournament_team_id
        GROUP BY tt.tournament_id
        LIMIT 1;

    SELECT mo.type INTO tournament_type FROM tournaments t
        inner join match_options mo on mo.id = t.match_options_id
        WHERE t.id = roster.tournament_id;

    min_players := get_match_type_min_players(match_type);

    IF roster_count < min_players THEN
    	UPDATE tournament_teams
		    SET eligible_at = null
		    WHERE id = roster.tournament_team_id;
        RETURN;
    END IF;
    UPDATE tournament_teams
    SET eligible_at = NOW()
    WHERE id = roster.tournament_team_id;
END;
$$;