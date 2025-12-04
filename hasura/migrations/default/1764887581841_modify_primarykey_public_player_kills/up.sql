update player_kills set attacker_steam_id = attacked_steam_id where attacker_steam_id is null;

alter table player_kills alter column attacker_steam_id set not null;

ALTER TABLE "public"."player_kills" DROP CONSTRAINT "player_kills_pkey";

ALTER TABLE "public"."player_kills"
    ADD CONSTRAINT "player_kills_pkey" PRIMARY KEY ("match_map_id", "time", "attacker_steam_id", "attacked_steam_id");

alter table "public"."player_kills" drop column if exists "id" cascade;
