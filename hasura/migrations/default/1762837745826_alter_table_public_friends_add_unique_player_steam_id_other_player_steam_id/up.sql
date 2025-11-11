alter table "public"."friends" add constraint "friends_player_steam_id_other_player_steam_id_key" unique ("player_steam_id", "other_player_steam_id");
