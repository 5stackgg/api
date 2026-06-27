-- Remove match-level lobby_access (visibility/join now lives in draft lobbies).
DROP INDEX IF EXISTS idx_match_options_id_lobby_access;

ALTER TABLE "public"."match_options" DROP CONSTRAINT IF EXISTS "match_options_lobby_access_fkey";

ALTER TABLE "public"."match_options" DROP COLUMN IF EXISTS "lobby_access";

-- Remove the match-level invite system (invites now live in draft lobbies).
DROP TABLE IF EXISTS "public"."match_invites";

-- Draft lobby invites: players added below the configured role threshold are
-- invited and must accept.
INSERT INTO "public"."e_draft_game_player_status" ("value", "description") VALUES
    ('Invited', 'Player Invited To Join')
ON CONFLICT ("value") DO NOTHING;
