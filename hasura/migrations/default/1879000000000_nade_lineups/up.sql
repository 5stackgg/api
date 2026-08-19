CREATE TABLE IF NOT EXISTS "public"."e_nade_visibility" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_nade_techniques" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_nade_throw_strengths" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_nade_sources" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."nade_lineups" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    -- maps is UNIQUE (name, type), so the same de_* map has one row per match
    -- type. A lineup is a fact about geometry, not about Competitive-vs-Wingman,
    -- so keying on maps.id would fragment the library and hide a Wingman
    -- player's smoke from a Competitive player. Validated by trigger instead;
    -- a real FK is impossible without a unique index on maps(name).
    "map_name" text NOT NULL,
    "workshop_map_id" text,

    "nade_type" text NOT NULL,
    "side" text NOT NULL,
    "technique" text NOT NULL,
    "throw_strength" text,
    -- Orthogonal to technique: a jumpthrow bind and a hand-timed jump throw are
    -- the same technique but not the same thing to reproduce.
    "jump_throw_bind" boolean NOT NULL DEFAULT false,

    -- Setup: where you stand and where you look. Source units, degrees.
    "origin_x" double precision NOT NULL,
    "origin_y" double precision NOT NULL,
    "origin_z" double precision NOT NULL,
    "eye_z" double precision,
    "view_yaw" double precision NOT NULL,
    "view_pitch" double precision NOT NULL,

    -- Result.
    "land_x" double precision NOT NULL,
    "land_y" double precision NOT NULL,
    "land_z" double precision NOT NULL,
    "flight_time_ms" integer,

    "name" text NOT NULL,
    "description" text,
    "tags" text[] NOT NULL DEFAULT '{}',

    "visibility" text NOT NULL DEFAULT 'Private',
    "team_id" uuid,
    "author_steam_id" bigint NOT NULL,

    "origin_source" text NOT NULL DEFAULT 'editor',
    "source_match_id" uuid,
    "source_match_map_id" uuid,
    "source_grenade_id" integer,
    "source_url" text,
    "external_id" text,
    -- exact = recorded by the plugin, derived = mined from a demo,
    -- low = imported. Drives the "verify this in a practice server" hint.
    "confidence" text NOT NULL DEFAULT 'exact',

    -- Up to 32 quantized points so a library grid renders a thumbnail from one
    -- GraphQL query. The full path and any smoke volume live in S3.
    "trajectory_preview" jsonb,
    "trajectory_file" text,
    "trajectory_size" integer,

    "upvotes" integer NOT NULL DEFAULT 0,
    "downvotes" integer NOT NULL DEFAULT 0,
    "favorites" integer NOT NULL DEFAULT 0,

    "verified_at" timestamptz,
    "archived_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("id"),

    CONSTRAINT "nade_lineups_nade_type_fkey" FOREIGN KEY ("nade_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_nade_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_throw_strength_fkey" FOREIGN KEY ("throw_strength")
        REFERENCES "public"."e_nade_throw_strengths" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_nade_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_origin_source_fkey" FOREIGN KEY ("origin_source")
        REFERENCES "public"."e_nade_sources" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_lineups_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_lineups_author_fkey" FOREIGN KEY ("author_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineups_source_match_fkey" FOREIGN KEY ("source_match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_lineups_source_match_map_fkey" FOREIGN KEY ("source_match_map_id")
        REFERENCES "public"."match_maps" ("id") ON UPDATE CASCADE ON DELETE SET NULL,

    -- Team visibility with no team is a lineup nobody can see.
    CONSTRAINT "nade_lineups_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL),
    CONSTRAINT "nade_lineups_confidence_chk"
        CHECK ("confidence" IN ('exact', 'derived', 'low'))
);

-- Cheap "is this the same smoke?" key: buckets the setup and the landing to a
-- 64-unit grid so ingest can dedupe and the UI can say "12 people run this".
ALTER TABLE "public"."nade_lineups"
    ADD COLUMN IF NOT EXISTS "lineup_bucket" text
    GENERATED ALWAYS AS (
        "map_name" || ':' || "nade_type" || ':' ||
        floor("origin_x" / 64)::int || ',' || floor("origin_y" / 64)::int || ':' ||
        floor("land_x" / 64)::int || ',' || floor("land_y" / 64)::int
    ) STORED;

CREATE INDEX IF NOT EXISTS "nade_lineups_public_browse_idx"
    ON "public"."nade_lineups" ("map_name", "nade_type", "side", "upvotes" DESC)
    WHERE "visibility" = 'Public' AND "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "nade_lineups_author_idx"
    ON "public"."nade_lineups" ("author_steam_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "nade_lineups_team_idx"
    ON "public"."nade_lineups" ("team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "nade_lineups_bucket_idx"
    ON "public"."nade_lineups" ("lineup_bucket");
CREATE INDEX IF NOT EXISTS "nade_lineups_tags_idx"
    ON "public"."nade_lineups" USING GIN ("tags");
CREATE UNIQUE INDEX IF NOT EXISTS "nade_lineups_external_idx"
    ON "public"."nade_lineups" ("origin_source", "external_id")
    WHERE "external_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "public"."nade_collections" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "description" text,
    -- Null for a mixed book that spans maps.
    "map_name" text,
    "owner_steam_id" bigint NOT NULL,
    "team_id" uuid,
    "visibility" text NOT NULL DEFAULT 'Private',
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("id"),
    CONSTRAINT "nade_collections_owner_fkey" FOREIGN KEY ("owner_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_collections_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_collections_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_nade_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_collections_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "nade_collections_owner_idx"
    ON "public"."nade_collections" ("owner_steam_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "public"."nade_collection_items" (
    "collection_id" uuid NOT NULL,
    "nade_lineup_id" uuid NOT NULL,
    "position" integer NOT NULL DEFAULT 0,
    "note" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("collection_id", "nade_lineup_id"),
    CONSTRAINT "nade_collection_items_collection_fkey" FOREIGN KEY ("collection_id")
        REFERENCES "public"."nade_collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_collection_items_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "nade_collection_items_lineup_idx"
    ON "public"."nade_collection_items" ("nade_lineup_id");

CREATE TABLE IF NOT EXISTS "public"."nade_lineup_votes" (
    "nade_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "vote" smallint NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("nade_lineup_id", "steam_id"),
    CONSTRAINT "nade_lineup_votes_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineup_votes_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineup_votes_vote_chk" CHECK ("vote" IN (-1, 1))
);

CREATE TABLE IF NOT EXISTS "public"."nade_lineup_favorites" (
    "nade_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("nade_lineup_id", "steam_id"),
    CONSTRAINT "nade_lineup_favorites_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineup_favorites_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "nade_lineup_favorites_steam_idx"
    ON "public"."nade_lineup_favorites" ("steam_id");

CREATE TABLE IF NOT EXISTS "public"."nade_lineup_progress" (
    "nade_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "successes" integer NOT NULL DEFAULT 0,
    "last_practiced_at" timestamptz,
    "mastered_at" timestamptz,
    PRIMARY KEY ("nade_lineup_id", "steam_id"),
    CONSTRAINT "nade_lineup_progress_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineup_progress_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE
);
