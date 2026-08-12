ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "camera_required" boolean NOT NULL DEFAULT false;

-- Lets a player see their own side's cameras. Never the other side: that would
-- hand a competitor a live view of the opposition.
ALTER TABLE "public"."match_options"
    ADD COLUMN IF NOT EXISTS "camera_allow_teammates" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "public"."match_camera_tokens" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "match_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "token" uuid DEFAULT gen_random_uuid() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON UPDATE cascade ON DELETE cascade,
    UNIQUE ("token"),
    UNIQUE ("match_id", "steam_id")
);

CREATE INDEX IF NOT EXISTS "match_camera_tokens_match_id_idx"
    ON "public"."match_camera_tokens" ("match_id");
