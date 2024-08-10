alter table "public"."players"
  add constraint "players_role_fkey"
  foreign key ("role")
  references "public"."e_player_roles"
  ("value") on update cascade on delete restrict;
