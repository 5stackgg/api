-- Replaced by a check in tbi_tournament_team: owner_steam_id is whoever created
-- the row (a Hasura insert preset), so an organizer adding teams by hand owns
-- all of them. Everyone else stays at one team per tournament, and a player can
-- only play once per tournament through tournament_roster_pkey.
ALTER TABLE "public"."tournament_teams"
  DROP CONSTRAINT IF EXISTS "tournament_teams_creator_steam_id_tournament_id_key";
