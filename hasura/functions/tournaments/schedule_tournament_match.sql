CREATE OR REPLACE FUNCTION public.schedule_tournament_match(bracket public.tournament_brackets) RETURNS uuid
     LANGUAGE plpgsql
     AS $$
 DECLARE
     tournament tournaments;
     stage tournament_stages;
     member RECORD;
     _lineup_1_id UUID;
     _lineup_2_id UUID;
     _captain_steam_id_1 bigint;
     _captain_steam_id_2 bigint;
     _match_id UUID;
     feeder RECORD;
     feeders_with_team int := 0;
     winner_id UUID;
     _template_match_options_id UUID;
     _match_options_id UUID;
     _round_best_of int;
     _swiss_match_type text;
 BEGIN
   	IF bracket.match_id IS NOT NULL THEN
   	 RETURN bracket.match_id;
   	END IF;
    
    -- If bracket is already finished, don't try to schedule it
    IF bracket.finished = true THEN
        RAISE NOTICE 'schedule_tournament_match: bracket % already finished, skipping', bracket.id;
        RETURN NULL;
    END IF;

    IF bracket.tournament_team_id_1 IS NULL AND bracket.tournament_team_id_2 IS NULL THEN
        RAISE NOTICE 'schedule_tournament_match: bracket % has no teams, skipping', bracket.id;
        RETURN NULL;
    END IF;

     -- For all other cases, we require two teams to schedule a match
     IF bracket.tournament_team_id_1 IS NULL OR bracket.tournament_team_id_2 IS NULL THEN
         RAISE NOTICE 'schedule_tournament_match: bracket % missing one team (t1=%, t2=%), skipping',
             bracket.id, bracket.tournament_team_id_1, bracket.tournament_team_id_2;
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

     -- Check bracket first (organizer overrides), then stage, then tournament
     IF bracket.match_options_id IS NOT NULL THEN
         _template_match_options_id := bracket.match_options_id;
     ELSIF stage.match_options_id IS NOT NULL THEN
         _template_match_options_id := stage.match_options_id;
     ELSE
         _template_match_options_id := tournament.match_options_id;
     END IF;

    -- Enforce match_mode:
    -- - admin mode requires an explicit organizer-set schedule on the bracket
    -- - other modes can continue existing auto-scheduling behavior
    DECLARE
        _match_mode text;
    BEGIN
        SELECT mo.match_mode INTO _match_mode
        FROM match_options mo WHERE mo.id = _template_match_options_id;

        IF _match_mode = 'admin' AND bracket.scheduled_at IS NULL THEN
            RAISE NOTICE 'schedule_tournament_match: bracket % is admin-mode without schedule, skipping auto-schedule', bracket.id;
            RETURN NULL;
        END IF;
    END;

     -- Per-round best_of resolution (only when bracket has no custom match_options)
     IF bracket.match_options_id IS NULL THEN
         IF stage.type = 'Swiss' THEN
             -- Swiss: decode group (wins*100+losses) to determine match type
             DECLARE
                 _wins int;
                 _losses int;
                 _wins_needed int := 3;
             BEGIN
                 _wins := (bracket."group" / 100)::int;
                 _losses := (bracket."group" % 100)::int;
                 IF _wins = _wins_needed - 1 THEN
                     _swiss_match_type := 'advancement';
                 ELSIF _losses = _wins_needed - 1 THEN
                     _swiss_match_type := 'elimination';
                 ELSE
                     _swiss_match_type := 'regular';
                 END IF;
                 _round_best_of := get_bracket_best_of(stage.id, _swiss_match_type, bracket.round);
             END;
         ELSE
             _round_best_of := get_bracket_best_of(stage.id, bracket.path, bracket.round);
         END IF;

         -- If round best_of differs from the resolved match_options, clone with new best_of
         IF _round_best_of IS NOT NULL THEN
             _match_options_id := clone_match_options_with_best_of(_template_match_options_id, _round_best_of);
         END IF;
     END IF;

     IF _match_options_id IS NULL THEN
         _match_options_id := clone_match_options(_template_match_options_id);
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
         GREATEST(COALESCE(bracket.scheduled_at, now()), now())
     )
     RETURNING id INTO _match_id;
         
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;

     -- Update match with lineup IDs
     UPDATE matches 
     SET lineup_1_id = _lineup_1_id,
         lineup_2_id = _lineup_2_id
     WHERE id = _match_id;

     SELECT tt.captain_steam_id
     INTO _captain_steam_id_1
     FROM tournament_teams tt
     WHERE tt.id = bracket.tournament_team_id_1;

     SELECT tt.captain_steam_id
     INTO _captain_steam_id_2
     FROM tournament_teams tt
     WHERE tt.id = bracket.tournament_team_id_2;

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

     IF _captain_steam_id_1 IS NOT NULL THEN
         UPDATE match_lineup_players
         SET captain = true
         WHERE match_lineup_id = _lineup_1_id
           AND steam_id = _captain_steam_id_1;
     END IF;

     IF _captain_steam_id_2 IS NOT NULL THEN
         UPDATE match_lineup_players
         SET captain = true
         WHERE match_lineup_id = _lineup_2_id
           AND steam_id = _captain_steam_id_2;
     END IF;

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