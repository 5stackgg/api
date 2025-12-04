ALTER TABLE "public"."player_utility" DROP CONSTRAINT "player_utility_pkey";

ALTER TABLE "public"."player_utility"
    ADD CONSTRAINT "player_utility_pkey" PRIMARY KEY ("match_map_id", "attacker_steam_id", "time");

alter table "public"."player_utility" drop column if exists "id" cascade;
