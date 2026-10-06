CREATE TABLE IF NOT EXISTS "public"."match_invites" (
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
