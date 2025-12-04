ALTER TABLE "public"."player_objectives" DROP CONSTRAINT "player_objectives_pkey";

ALTER TABLE "public"."player_objectives"
    ADD CONSTRAINT "player_objectives_pkey" PRIMARY KEY ("match_map_id", "time", "player_steam_id");

alter table "public"."player_objectives" drop column if exists "id" cascade;
