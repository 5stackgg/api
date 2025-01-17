CREATE TABLE "public"."friends" ("player_steam_id" int8 NOT NULL, "other_player_steam_id" bigint NOT NULL, "status" text NOT NULL, PRIMARY KEY ("player_steam_id","other_player_steam_id") , FOREIGN KEY ("player_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade, FOREIGN KEY ("other_player_steam_id") REFERENCES "public"."players"("steam_id") ON UPDATE cascade ON DELETE cascade);

CREATE TABLE "public"."e_friend_status" ("value" text NOT NULL, "description" Text NOT NULL, PRIMARY KEY ("value") , UNIQUE ("value"));

alter table "public"."friends"
  add constraint "friends_status_fkey"
  foreign key ("status")
  references "public"."e_friend_status"
  ("value") on update cascade on delete restrict;

