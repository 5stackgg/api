DELETE FROM "public"."e_draft_game_player_status" WHERE "value" = 'Invited';

CREATE TABLE "public"."match_invites" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "match_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "invited_by_player_steam_id" bigint NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    FOREIGN KEY ("match_id")
        REFERENCES "public"."matches"("id")
        ON UPDATE cascade
        ON DELETE cascade,
    FOREIGN KEY ("steam_id")
        REFERENCES "public"."players"("steam_id")
        ON UPDATE cascade
        ON DELETE cascade,
    FOREIGN KEY ("invited_by_player_steam_id")
        REFERENCES "public"."players"("steam_id")
        ON UPDATE cascade
        ON DELETE cascade,
    UNIQUE ("match_id", "invited_by_player_steam_id", "steam_id")
);

ALTER TABLE "public"."match_options" ADD COLUMN IF NOT EXISTS "lobby_access" text NULL DEFAULT 'Private';

ALTER TABLE "public"."match_options"
  ADD CONSTRAINT "match_options_lobby_access_fkey"
  FOREIGN KEY ("lobby_access")
  REFERENCES "public"."e_lobby_access" ("value") ON UPDATE cascade ON DELETE restrict;

CREATE INDEX IF NOT EXISTS idx_match_options_id_lobby_access
ON match_options(id, lobby_access)
INCLUDE (type);
