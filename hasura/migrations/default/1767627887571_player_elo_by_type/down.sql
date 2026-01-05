alter table "public"."player_elo" drop constraint "player_elo_pkey";
alter table "public"."player_elo"
    add constraint "player_elo_pkey"
    primary key ("steam_id", "match_id");

alter table "public"."player_elo" drop constraint "player_elo_type_fkey";

alter table "public"."player_elo" drop column if exists "type";