alter table "public"."tournament_team_roster"
  add constraint "tournament_team_roster_role_fkey"
  foreign key ("role")
  references "public"."e_team_roles"
  ("value") on update cascade on delete restrict;
