ALTER TABLE "public"."player_damages" DROP CONSTRAINT "player_damages_pkey";

ALTER TABLE "public"."player_damages"
    ADD CONSTRAINT "player_damages_pkey" PRIMARY KEY ("time", "match_map_id", "id");
