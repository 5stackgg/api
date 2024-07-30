CREATE OR REPLACE FUNCTION public.seed_tournament(tournament tournaments) RETURNS VOID
    LANGUAGE plpgsql
    AS $$
DECLARE
    available_teams uuid[];
    bracket RECORD;
    team_id uuid;
    team_id1 uuid;
    team_id2 uuid;
BEGIN
    PERFORM update_tournament_stages(tournament.id);
    -- Fetch all available team ids into an array
    SELECT array_agg(id) INTO available_teams
    FROM tournament_teams
    WHERE tournament_id = tournament.id AND eligible_at IS NOT NULL;
    -- Ensure there are teams available to seed
    IF array_length(available_teams, 1) IS NULL THEN
        RETURN;
    END IF;
    -- Iterate through each bracket and update with team ids
    FOR bracket IN
        SELECT tb.*
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts on ts.id = tb.tournament_stage_id and ts.order = 1
        WHERE tournament_id = tournament.id
        ORDER BY match_number ASC
    LOOP
        -- Pop two teams from the available teams array
     	team_id1 := available_teams[1];
        available_teams := array_remove(available_teams, team_id1);
		team_id2 := available_teams[1];
        available_teams := array_remove(available_teams, team_id2);
        UPDATE tournament_brackets SET  tournament_team_id_1 = team_id1, tournament_team_id_2 = team_id2 WHERE id = bracket.id;
    END LOOP;
    RETURN;
END;
$$;