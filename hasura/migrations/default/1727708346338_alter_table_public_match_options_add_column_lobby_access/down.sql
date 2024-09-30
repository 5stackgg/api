alter table "public"."match_options" drop constraint "match_options_lobby_access_fkey";

alter table "public"."match_options" drop column if exists "lobby_access";
