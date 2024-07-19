alter table "public"."tournament_teams"
  add constraint "tournament_teams_creator_steam_id_fkey"
  foreign key ("creator_steam_id")
  references "public"."players"
  ("steam_id") on update cascade on delete restrict;
