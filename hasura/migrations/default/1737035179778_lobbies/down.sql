
DROP TABLE "public"."lobby_players";

alter table "public"."lobbies" drop constraint "lobbies_status_fkey";

DROP TABLE "public"."lobbies";
