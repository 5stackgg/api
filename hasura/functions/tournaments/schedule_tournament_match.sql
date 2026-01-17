CREATE OR REPLACE FUNCTION public.schedule_tournament_match(bracket public.tournament_brackets) RETURNS uuid
     LANGUAGE plpgsql
     AS $$
 DECLARE
     tournament tournaments;
     stage tournament_stages;
     member RECORD;
     _lineup_1_id UUID;
     _lineup_2_id UUID;
     _match_id UUID;
     feeder RECORD;
     feeders_with_team int := 0;
     winner_id UUID;
     _match_options_id UUID;
 BEGIN
   	IF bracket.match_id IS NOT NULL THEN
   	 RETURN bracket.match_id;
   	END IF;
    
    -- If bracket is already finished, don't try to schedule it
    IF bracket.finished = true THEN
        RETURN NULL;
    END IF;
    
    IF bracket.tournament_team_id_1 IS NULL AND bracket.tournament_team_id_2 IS NULL THEN
        RETURN NULL;
    END IF;

     -- For all other cases, we require two teams to schedule a match
     IF bracket.tournament_team_id_1 IS NULL OR bracket.tournament_team_id_2 IS NULL THEN
         RETURN NULL;
     END IF;

     -- Fetch stage values
     SELECT ts.* INTO stage
     FROM tournament_brackets tb
     INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
     WHERE tb.id = bracket.id;

     -- Fetch tournament values
     SELECT t.* INTO tournament
     FROM tournament_brackets tb
     INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
     INNER JOIN tournaments t ON t.id = ts.tournament_id
     WHERE tb.id = bracket.id;

     -- Check if stage has match_options_id first, otherwise use tournament match_options_id
     IF stage.match_options_id IS NOT NULL THEN
         _match_options_id := stage.match_options_id;
     ELSIF bracket.match_options_id IS NOT NULL THEN
         _match_options_id := bracket.match_options_id;
     ELSE
         _match_options_id := tournament.match_options_id;
     END IF;

     -- Create the match first
     INSERT INTO matches (
         status,
         organizer_steam_id,
         match_options_id,
         scheduled_at
     )
     VALUES (
         'PickingPlayers',
         tournament.organizer_steam_id,
         _match_options_id,
         now()
     )
     RETURNING id INTO _match_id;
         
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;

     -- Update match with lineup IDs
     UPDATE matches 
     SET lineup_1_id = _lineup_1_id,
         lineup_2_id = _lineup_2_id
     WHERE id = _match_id;

     FOR member IN
         SELECT * FROM tournament_team_roster
         WHERE tournament_team_id = bracket.tournament_team_id_1
     LOOP
         INSERT INTO match_lineup_players (match_lineup_id, steam_id)
         VALUES (_lineup_1_id, member.player_steam_id);
     END LOOP;

     FOR member IN
         SELECT * FROM tournament_team_roster
         WHERE tournament_team_id = bracket.tournament_team_id_2
     LOOP
         INSERT INTO match_lineup_players (match_lineup_id, steam_id)
         VALUES (_lineup_2_id, member.player_steam_id);
     END LOOP;

     UPDATE matches
     SET status = 'WaitingForCheckIn'
     WHERE id = _match_id;

     UPDATE tournament_brackets
     SET match_id = _match_id
     WHERE id = bracket.id;

     PERFORM calculate_tournament_bracket_start_times(tournament.id);

     RETURN _match_id;
 END;
 $$;