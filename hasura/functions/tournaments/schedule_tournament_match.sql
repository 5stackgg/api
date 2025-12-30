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
    
    IF bracket.tournament_team_id_1 IS NULL AND bracket.tournament_team_id_2 IS NULL THEN
        RETURN NULL;
    END IF;

     -- Special handling for losers-bracket matches where we may effectively have a bye
     IF COALESCE(bracket.path, 'WB') = 'LB' THEN
         -- Exactly one team present: decide whether a second team can still appear
         IF bracket.tournament_team_id_1 IS NULL OR bracket.tournament_team_id_2 IS NULL THEN
             FOR feeder IN
                 SELECT tb.*
                 FROM tournament_brackets tb
                 WHERE tb.parent_bracket_id = bracket.id
                    OR tb.loser_parent_bracket_id = bracket.id
             LOOP
                 IF feeder.tournament_team_id_1 IS NOT NULL OR feeder.tournament_team_id_2 IS NOT NULL THEN
                     feeders_with_team := feeders_with_team + 1;
                 END IF;
             END LOOP;

             -- If we don't have at least one team in both feeder matches,
             -- treat this as an effective bye and auto-advance the existing team.
             IF feeders_with_team < 2 THEN
                 winner_id := COALESCE(bracket.tournament_team_id_1, bracket.tournament_team_id_2);

                 IF winner_id IS NOT NULL AND bracket.parent_bracket_id IS NOT NULL THEN
                    update tournament_brackets
                    SET finished = true
                    WHERE id = bracket.id;
                    
                    PERFORM public.assign_team_to_bracket_slot(bracket.parent_bracket_id, winner_id);
                 END IF;

                 RETURN NULL;
             END IF;
         END IF;
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