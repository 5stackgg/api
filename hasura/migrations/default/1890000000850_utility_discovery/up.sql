-- Lineup discovery: a player names a spot they want a smoke on and an area to
-- throw from, a flight model proposes throws, and a render server throws each
-- one for real.

-- A practice session booked to throw a discovery's proposals. It runs the
-- plugin's render mode like a render session, but nothing films it, so it has
-- no render pod and needs no GPU node.
ALTER TABLE public.utility_practice_sessions
    ADD COLUMN IF NOT EXISTS is_discovery boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "public"."utility_discoveries" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "requested_by_steam_id" bigint NOT NULL,
    "map_name" text NOT NULL,
    "utility_type" text NOT NULL DEFAULT 'Smoke',

    "target_x" double precision NOT NULL,
    "target_y" double precision NOT NULL,
    "target_z" double precision NOT NULL,
    "radius" real NOT NULL,

    -- What was asked for, as the request named it: {min, max, radius?},
    -- [{direction, gait, jump_throw}] and the mouse buttons.
    "area" jsonb NOT NULL,
    "techniques" jsonb NOT NULL,
    "strengths" text[] NOT NULL,

    "status" text NOT NULL DEFAULT 'Predicting',
    "predicted" integer NOT NULL DEFAULT 0,
    "verified" integer NOT NULL DEFAULT 0,
    "missed" integer NOT NULL DEFAULT 0,
    "grenades" integer NOT NULL DEFAULT 0,

    -- Which map build the proposals were made against.
    "mesh_revision" text,
    "error" text,

    "utility_practice_session_id" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "started_at" timestamptz,
    "finished_at" timestamptz,

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_discoveries_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_discoveries_session_fkey" FOREIGN KEY ("utility_practice_session_id")
        REFERENCES "public"."utility_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_discoveries_status_chk"
        CHECK ("status" IN ('Predicting', 'Queued', 'Verifying', 'Done', 'Failed', 'Cancelled'))
);

CREATE INDEX IF NOT EXISTS "utility_discoveries_requested_by_idx"
    ON "public"."utility_discoveries" ("requested_by_steam_id", "created_at" DESC);

-- One running discovery a player, held by the database: a check before the
-- insert lets a burst of requests all through.
CREATE UNIQUE INDEX IF NOT EXISTS "utility_discoveries_one_active_idx"
    ON "public"."utility_discoveries" ("requested_by_steam_id")
    WHERE "status" IN ('Predicting', 'Queued', 'Verifying');

-- The verification queue's only read.
CREATE INDEX IF NOT EXISTS "utility_discoveries_queue_idx"
    ON "public"."utility_discoveries" ("created_at")
    WHERE "status" IN ('Queued', 'Verifying');

CREATE TABLE IF NOT EXISTS "public"."utility_discovery_results" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "discovery_id" uuid NOT NULL,

    -- Easiest first, as the flight model ranked them.
    "rank" integer NOT NULL,

    "technique" text NOT NULL,
    "move_direction" text,
    "move_gait" text,
    "jump_throw" boolean NOT NULL DEFAULT false,
    -- A walk or a run at full speed has not been measured yet; a throw that
    -- depends on one says so.
    "measured" boolean NOT NULL DEFAULT true,
    "strength" text NOT NULL,

    "stand_x" double precision NOT NULL,
    "stand_y" double precision NOT NULL,
    "stand_z" double precision NOT NULL,
    "eye_z" double precision NOT NULL,

    -- The aim and the seed it throws: proposed, then refined in place by the
    -- server if the proposal missed and something next to it landed.
    "pitch" double precision NOT NULL,
    "yaw" double precision NOT NULL,
    "initial_pos_x" double precision NOT NULL,
    "initial_pos_y" double precision NOT NULL,
    "initial_pos_z" double precision NOT NULL,
    "initial_vel_x" double precision NOT NULL,
    "initial_vel_y" double precision NOT NULL,
    "initial_vel_z" double precision NOT NULL,

    "predicted_land_x" double precision NOT NULL,
    "predicted_land_y" double precision NOT NULL,
    "predicted_land_z" double precision NOT NULL,
    "predicted_distance" real NOT NULL,
    "predicted_spread" real NOT NULL,
    "predicted_bounces" integer NOT NULL,

    "status" text NOT NULL DEFAULT 'predicted',

    -- Where the real grenade went, once thrown.
    "land_x" double precision,
    "land_y" double precision,
    "land_z" double precision,
    "distance" real,
    "bounces" integer,
    "flight_time_ms" integer,
    -- How far a quarter degree of aim error either way moved the real landing.
    "forgiveness" real,
    "grenades" integer,
    "path" jsonb,

    -- Nothing in the library or the mined meta throws from this spot onto
    -- this one.
    "is_new" boolean,

    "utility_lineup_id" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "verified_at" timestamptz,

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_discovery_results_discovery_fkey" FOREIGN KEY ("discovery_id")
        REFERENCES "public"."utility_discoveries" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_discovery_results_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_discovery_results_status_chk"
        CHECK ("status" IN ('predicted', 'verified', 'missed')),
    CONSTRAINT "utility_discovery_results_strength_chk"
        CHECK ("strength" IN ('Full', 'Half', 'Drop'))
);

CREATE INDEX IF NOT EXISTS "utility_discovery_results_discovery_idx"
    ON "public"."utility_discovery_results" ("discovery_id", "rank");
