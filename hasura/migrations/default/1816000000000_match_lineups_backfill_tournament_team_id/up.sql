UPDATE match_lineups ml
   SET team_id = tt.team_id
  FROM tournament_brackets tb
  JOIN tournament_teams tt ON tt.id = tb.tournament_team_id_1
  JOIN matches m ON m.id = tb.match_id
 WHERE ml.id = m.lineup_1_id
   AND ml.team_id IS NULL
   AND tt.team_id IS NOT NULL;

UPDATE match_lineups ml
   SET team_id = tt.team_id
  FROM tournament_brackets tb
  JOIN tournament_teams tt ON tt.id = tb.tournament_team_id_2
  JOIN matches m ON m.id = tb.match_id
 WHERE ml.id = m.lineup_2_id
   AND ml.team_id IS NULL
   AND tt.team_id IS NOT NULL;
