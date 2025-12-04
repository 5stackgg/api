alter table "public"."player_damages" drop constraint "player_damages_pkey";
alter table "public"."player_damages"
    add constraint "player_damages_pkey"
    primary key ("match_id", "time", "match_map_id", "id");
