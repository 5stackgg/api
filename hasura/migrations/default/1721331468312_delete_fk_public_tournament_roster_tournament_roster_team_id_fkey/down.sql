alter table "public"."tournament_roster"
  add constraint "tournament_roster_team_id_fkey"
  foreign key ("tournament_team_id")
  references "public"."teams"
  ("id") on update cascade on delete cascade;
