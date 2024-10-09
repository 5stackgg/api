alter table "public"."tournament_teams" add constraint "tournament_teams_tournament_id_name_key" unique ("tournament_id", "name");
