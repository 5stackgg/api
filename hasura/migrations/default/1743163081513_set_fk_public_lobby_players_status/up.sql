alter table "public"."lobby_players"
  add constraint "lobby_players_status_fkey"
  foreign key ("status")
  references "public"."e_lobby_player_status"
  ("value") on update cascade on delete restrict;
