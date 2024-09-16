CREATE TABLE IF NOT EXISTS "public"."abandoned_matches" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "steam_id" bigint NOT NULL,
    "abandoned_at" timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("id")
);
