alter table "public"."player_kills_by_weapon" drop constraint "player_kills_by_weapon_player_steam_id_fkey";

DROP TABLE IF EXISTS player_stats;

alter table "public"."player_stats" drop constraint "player_stats_player_steam_id_fkey";

DROP TABLE IF EXISTS player_kills_by_weapon;