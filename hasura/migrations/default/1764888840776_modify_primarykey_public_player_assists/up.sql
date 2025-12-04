ALTER TABLE "public"."player_assists" DROP CONSTRAINT "player_assists_pkey";

ALTER TABLE "public"."player_assists"
    ADD CONSTRAINT "player_assists_pkey" PRIMARY KEY ("match_map_id", "attacker_steam_id", "attacked_steam_id", "time");

alter table "public"."player_assists" drop column if exists "id" cascade;
