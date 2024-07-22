BEGIN TRANSACTION;
ALTER TABLE "public"."tournament_servers" DROP CONSTRAINT "tournament_servers_pkey";

ALTER TABLE "public"."tournament_servers"
    ADD CONSTRAINT "tournament_servers_pkey" PRIMARY KEY ("server_id", "tournament_id");
COMMIT TRANSACTION;
