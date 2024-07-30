CREATE FUNCTION public.check_team_eligibility() RETURNS trigger
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
    WHERE tt.id = NEW.tournament_team_id
    GROUP BY tt.tournament_id
    LIMIT 1;
    SELECT mo.type INTO tournament_type FROM tournaments t
        inner join match_options mo on mo.id = t.match_options_id
        WHERE t.id = NEW.tournament_id;
    min_players := CASE
                   WHEN tournament_type = 'Wingman' THEN 2
                      ELSE 5
                   END;
    IF roster_count < min_players THEN
    	UPDATE tournament_teams
		    SET eligible_at = null
		    WHERE id = NEW.tournament_team_id;
        RETURN NEW;
    END IF;
    UPDATE tournament_teams
    SET eligible_at = NOW()
    WHERE id = NEW.tournament_team_id;
    RETURN NEW;
END;
$$;