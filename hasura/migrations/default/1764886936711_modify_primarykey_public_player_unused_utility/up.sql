ALTER TABLE "public"."player_unused_utility" DROP CONSTRAINT "player_unused_utility_pkey";

ALTER TABLE "public"."player_unused_utility"
    ADD CONSTRAINT "player_unused_utility_pkey" PRIMARY KEY ("match_map_id", "player_steam_id");

alter table "public"."player_unused_utility" drop column if exists "id" cascade;
