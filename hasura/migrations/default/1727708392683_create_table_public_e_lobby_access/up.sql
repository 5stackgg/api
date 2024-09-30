CREATE TABLE "public"."e_lobby_access" ("value" text NOT NULL, "description" Text NOT NULL, PRIMARY KEY ("value") );


alter table "public"."match_options"
  add constraint "match_options_lobby_access_fkey"
  foreign key ("lobby_access")
  references "public"."e_lobby_access"
  ("value") on update cascade on delete restrict;
