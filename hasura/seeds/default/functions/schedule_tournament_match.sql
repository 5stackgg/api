CREATE OR REPLACE FUNCTION public.schedule_tournament_match(bracket public.tournament_brackets) RETURNS uuid
     LANGUAGE plpgsql
     AS $$
 DECLARE
     tournament tournaments;
     member RECORD;
     _lineup_1_id UUID;
     _lineup_2_id UUID;
     _match_id UUID;
 BEGIN
   	IF bracket.match_id IS NOT NULL THEN
   	 return bracket.match_id;
   	END IF;
     IF bracket.tournament_team_id_1 IS NULL OR bracket.tournament_team_id_2 IS NULL THEN
         RETURN NULL;
     END IF;
     select t.* into tournament from
         tournament_brackets tb
         INNER JOIN tournament_stages ts on ts.id = tb.tournament_stage_id
         INNER JOIN tournaments t on t.id = ts.tournament_id
         where tb.id = bracket.id;
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_1_id;
     INSERT INTO match_lineups DEFAULT VALUES RETURNING id INTO _lineup_2_id;
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
     INSERT INTO matches (
         status,
         organizer_steam_id,
         match_options_id,
         lineup_1_id,
         lineup_2_id
     )
     VALUES (
         'Veto',
         tournament.organizer_steam_id,
         tournament.match_options_id,
         _lineup_1_id,
         _lineup_2_id
     )
     RETURNING id INTO _match_id;
     UPDATE tournament_brackets
     SET match_id = _match_id
     WHERE id = bracket.id;
     RETURN _match_id;
 END;
 $$;