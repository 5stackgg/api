
DROP TABLE "public"."lobby_players";

alter table "public"."lobbies" drop constraint "lobbies_access_fkey";

DROP TABLE "public"."lobbies";
