-- owner_steam_id is whoever created the row (a Hasura insert preset), so an
-- organizer adding teams by hand, or one person owning an A and a B team, owns
-- several teams in the same tournament. A player can still only play once per
-- tournament: tournament_roster_pkey is (player_steam_id, tournament_id).
ALTER TABLE "public"."tournament_teams"
  DROP CONSTRAINT IF EXISTS "tournament_teams_creator_steam_id_tournament_id_key";
