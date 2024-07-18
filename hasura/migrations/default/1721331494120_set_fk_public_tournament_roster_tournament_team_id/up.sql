alter table "public"."tournament_roster"
  add constraint "tournament_roster_tournament_team_id_fkey"
  foreign key ("tournament_team_id")
  references "public"."tournament_teams"
  ("id") on update cascade on delete cascade;
