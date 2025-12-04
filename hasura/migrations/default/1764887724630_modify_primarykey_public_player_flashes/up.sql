ALTER TABLE "public"."player_flashes" DROP CONSTRAINT "player_flashes_pkey";

ALTER TABLE "public"."player_flashes"
    ADD CONSTRAINT "player_flashes_pkey" PRIMARY KEY ("match_map_id", "time", "attacker_steam_id", "attacked_steam_id");

alter table "public"."player_flashes" drop column if exists "id" cascade;
