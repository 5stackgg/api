-- The meta: which lineups people actually throw, mined out of every demo the
-- platform has kept, independent of whether anyone bothered to save one.
--
-- Two tables rather than one view, because the two questions have different
-- shapes. nade_demo_throws is the fact table -- one row per grenade the miner
-- recovered -- and it only ever grows: a ten-player map produces a few hundred
-- throws, so ten thousand demos is a few million rows, which is nothing to
-- aggregate once and everything to aggregate on every page load. A view over it
-- would re-scan the lot per browse, and PostgreSQL cannot refresh a
-- MATERIALIZED VIEW incrementally -- it can only rebuild the whole thing -- so
-- the aggregate is a plain table the job upserts per map instead.

CREATE TABLE IF NOT EXISTS "public"."nade_demo_throws" (
    -- Keyed on the demo and the grenade rather than a surrogate: re-mining a
    -- demo has to be idempotent, and the demo's own grenade id is what makes
    -- one throw the same throw across two runs.
    "match_map_demo_id" uuid NOT NULL,
    "grenade_id" integer NOT NULL,

    "match_id" uuid,
    "match_map_id" uuid,

    "map_name" text NOT NULL,
    "nade_type" text NOT NULL,
    "side" text NOT NULL,
    "technique" text NOT NULL,
    "throw_strength" text,

    -- Not a FK to players: a demo carries whatever steam ids were on the
    -- server, and an imported match's are frequently accounts this platform
    -- has never seen. A FK here would drop exactly the throws worth counting.
    "thrower_steam_id" bigint,

    "round" integer,
    "tick" integer,

    "origin_x" double precision NOT NULL,
    "origin_y" double precision NOT NULL,
    "origin_z" double precision NOT NULL,
    "land_x" double precision NOT NULL,
    "land_y" double precision NOT NULL,
    "land_z" double precision NOT NULL,
    "view_yaw" double precision,
    "view_pitch" double precision,
    "flight_time_ms" integer,

    "thrown_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("match_map_demo_id", "grenade_id"),

    CONSTRAINT "nade_demo_throws_demo_fkey" FOREIGN KEY ("match_map_demo_id")
        REFERENCES "public"."match_map_demos" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_demo_throws_match_fkey" FOREIGN KEY ("match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_demo_throws_match_map_fkey" FOREIGN KEY ("match_map_id")
        REFERENCES "public"."match_maps" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_demo_throws_nade_type_fkey" FOREIGN KEY ("nade_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_demo_throws_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_demo_throws_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_nade_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_demo_throws_throw_strength_fkey" FOREIGN KEY ("throw_strength")
        REFERENCES "public"."e_nade_throw_strengths" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Byte for byte the expression nade_lineups.lineup_bucket uses, so a saved
-- lineup and the throws behind it land in the same bucket. Changing one without
-- the other silently splits every cluster in half.
ALTER TABLE "public"."nade_demo_throws"
    ADD COLUMN IF NOT EXISTS "lineup_bucket" text
    GENERATED ALWAYS AS (
        "map_name" || ':' || "nade_type" || ':' ||
        floor("origin_x" / 64)::int || ',' || floor("origin_y" / 64)::int || ':' ||
        floor("land_x" / 64)::int || ',' || floor("land_y" / 64)::int
    ) STORED;

CREATE INDEX IF NOT EXISTS "nade_demo_throws_bucket_idx"
    ON "public"."nade_demo_throws" ("lineup_bucket");
CREATE INDEX IF NOT EXISTS "nade_demo_throws_map_idx"
    ON "public"."nade_demo_throws" ("map_name", "nade_type");
CREATE INDEX IF NOT EXISTS "nade_demo_throws_thrower_idx"
    ON "public"."nade_demo_throws" ("thrower_steam_id")
    WHERE "thrower_steam_id" IS NOT NULL;

-- Which demos the miner has already been through, and at what version of it.
-- A demo that yielded nothing still gets a row: without one the job would pick
-- the same empty demo up forever.
CREATE TABLE IF NOT EXISTS "public"."nade_demo_mines" (
    "match_map_demo_id" uuid NOT NULL,
    "version" integer NOT NULL,
    "throws" integer NOT NULL DEFAULT 0,
    "failed_reason" text,
    "mined_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("match_map_demo_id"),
    CONSTRAINT "nade_demo_mines_demo_fkey" FOREIGN KEY ("match_map_demo_id")
        REFERENCES "public"."match_map_demos" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "nade_demo_mines_version_idx"
    ON "public"."nade_demo_mines" ("version", "mined_at");

-- One row per cluster: the lineup people actually run, and how many of them.
CREATE TABLE IF NOT EXISTS "public"."nade_meta_lineups" (
    "lineup_bucket" text NOT NULL,

    "map_name" text NOT NULL,
    "nade_type" text NOT NULL,
    -- The side that throws it most, not the only side that throws it.
    "side" text NOT NULL,
    "technique" text NOT NULL,
    "throw_strength" text,

    "throws" integer NOT NULL DEFAULT 0,
    -- The "12 people run this" number: distinct throwers, not distinct throws.
    "throwers" integer NOT NULL DEFAULT 0,
    "matches" integer NOT NULL DEFAULT 0,
    -- How many saved lineups share this bucket, so the UI can offer the meta
    -- throw nobody has written up yet.
    "lineups" integer NOT NULL DEFAULT 0,

    -- Medians rather than means: one misthrow in the bucket should not drag the
    -- representative point off the spot everyone else stands on.
    "origin_x" double precision NOT NULL,
    "origin_y" double precision NOT NULL,
    "origin_z" double precision NOT NULL,
    "land_x" double precision NOT NULL,
    "land_y" double precision NOT NULL,
    "land_z" double precision NOT NULL,
    "view_yaw" double precision,
    "view_pitch" double precision,

    "first_seen_at" timestamptz,
    "last_seen_at" timestamptz,
    "refreshed_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("lineup_bucket"),

    CONSTRAINT "nade_meta_lineups_nade_type_fkey" FOREIGN KEY ("nade_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_meta_lineups_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_meta_lineups_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_nade_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "nade_meta_lineups_browse_idx"
    ON "public"."nade_meta_lineups" ("map_name", "nade_type", "throwers" DESC);
