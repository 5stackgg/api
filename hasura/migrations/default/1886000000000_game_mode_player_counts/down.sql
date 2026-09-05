ALTER TABLE "public"."match_options" DROP COLUMN IF EXISTS "expected_players";
ALTER TABLE "public"."match_options" DROP COLUMN IF EXISTS "min_players_per_lineup";

ALTER TABLE "public"."game_modes" DROP CONSTRAINT IF EXISTS "game_modes_players_per_team_check";
ALTER TABLE "public"."game_modes" DROP COLUMN IF EXISTS "allow_short_handed_start";
ALTER TABLE "public"."game_modes" DROP COLUMN IF EXISTS "players_per_team";
