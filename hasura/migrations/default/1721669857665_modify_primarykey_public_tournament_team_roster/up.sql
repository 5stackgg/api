BEGIN TRANSACTION;
ALTER TABLE "public"."tournament_team_roster" DROP CONSTRAINT "tournament_roster_pkey";

ALTER TABLE "public"."tournament_team_roster"
    ADD CONSTRAINT "tournament_roster_pkey" PRIMARY KEY ("player_steam_id", "tournament_id");
COMMIT TRANSACTION;
