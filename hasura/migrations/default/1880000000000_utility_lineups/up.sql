-- utility_lineups
CREATE TABLE IF NOT EXISTS "public"."e_utility_visibility" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_utility_techniques" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_utility_throw_strengths" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."e_utility_sources" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."utility_lineups" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    -- maps is UNIQUE (name, type), so the same de_* map has one row per match
    -- type. A lineup is a fact about geometry, not about Competitive-vs-Wingman,
    -- so keying on maps.id would fragment the library and hide a Wingman
    -- player's smoke from a Competitive player. Validated by trigger instead;
    -- a real FK is impossible without a unique index on maps(name).
    "map_name" text NOT NULL,
    "workshop_map_id" text,

    "utility_type" text NOT NULL,
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

    CONSTRAINT "utility_lineups_utility_type_fkey" FOREIGN KEY ("utility_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_utility_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_throw_strength_fkey" FOREIGN KEY ("throw_strength")
        REFERENCES "public"."e_utility_throw_strengths" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_utility_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_origin_source_fkey" FOREIGN KEY ("origin_source")
        REFERENCES "public"."e_utility_sources" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_lineups_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineups_author_fkey" FOREIGN KEY ("author_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineups_source_match_fkey" FOREIGN KEY ("source_match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineups_source_match_map_fkey" FOREIGN KEY ("source_match_map_id")
        REFERENCES "public"."match_maps" ("id") ON UPDATE CASCADE ON DELETE SET NULL,

    -- Team visibility with no team is a lineup nobody can see.
    CONSTRAINT "utility_lineups_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL),
    CONSTRAINT "utility_lineups_confidence_chk"
        CHECK ("confidence" IN ('exact', 'derived', 'low'))
);

-- Cheap "is this the same smoke?" key: buckets the setup and the landing to a
-- 64-unit grid so ingest can dedupe and the UI can say "12 people run this".
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "lineup_bucket" text
    GENERATED ALWAYS AS (
        "map_name" || ':' || "utility_type" || ':' ||
        floor("origin_x" / 64)::int || ',' || floor("origin_y" / 64)::int || ':' ||
        floor("land_x" / 64)::int || ',' || floor("land_y" / 64)::int
    ) STORED;

CREATE INDEX IF NOT EXISTS "utility_lineups_public_browse_idx"
    ON "public"."utility_lineups" ("map_name", "utility_type", "side", "upvotes" DESC)
    WHERE "visibility" = 'Public' AND "archived_at" IS NULL;
CREATE INDEX IF NOT EXISTS "utility_lineups_author_idx"
    ON "public"."utility_lineups" ("author_steam_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "utility_lineups_team_idx"
    ON "public"."utility_lineups" ("team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "utility_lineups_bucket_idx"
    ON "public"."utility_lineups" ("lineup_bucket");
CREATE INDEX IF NOT EXISTS "utility_lineups_tags_idx"
    ON "public"."utility_lineups" USING GIN ("tags");
CREATE UNIQUE INDEX IF NOT EXISTS "utility_lineups_external_idx"
    ON "public"."utility_lineups" ("origin_source", "external_id")
    WHERE "external_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "public"."utility_collections" (
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
    CONSTRAINT "utility_collections_owner_fkey" FOREIGN KEY ("owner_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_collections_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_collections_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_utility_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_collections_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "utility_collections_owner_idx"
    ON "public"."utility_collections" ("owner_steam_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "public"."utility_collection_items" (
    "collection_id" uuid NOT NULL,
    "utility_lineup_id" uuid NOT NULL,
    "position" integer NOT NULL DEFAULT 0,
    "note" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("collection_id", "utility_lineup_id"),
    CONSTRAINT "utility_collection_items_collection_fkey" FOREIGN KEY ("collection_id")
        REFERENCES "public"."utility_collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_collection_items_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "utility_collection_items_lineup_idx"
    ON "public"."utility_collection_items" ("utility_lineup_id");

CREATE TABLE IF NOT EXISTS "public"."utility_lineup_votes" (
    "utility_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "vote" smallint NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("utility_lineup_id", "steam_id"),
    CONSTRAINT "utility_lineup_votes_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_votes_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_votes_vote_chk" CHECK ("vote" IN (-1, 1))
);

CREATE TABLE IF NOT EXISTS "public"."utility_lineup_favorites" (
    "utility_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("utility_lineup_id", "steam_id"),
    CONSTRAINT "utility_lineup_favorites_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_favorites_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "utility_lineup_favorites_steam_idx"
    ON "public"."utility_lineup_favorites" ("steam_id");

CREATE TABLE IF NOT EXISTS "public"."utility_lineup_progress" (
    "utility_lineup_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "successes" integer NOT NULL DEFAULT 0,
    "last_practiced_at" timestamptz,
    "mastered_at" timestamptz,
    PRIMARY KEY ("utility_lineup_id", "steam_id"),
    CONSTRAINT "utility_lineup_progress_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_progress_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- utility_practice_sessions
CREATE TABLE IF NOT EXISTS "public"."e_utility_practice_statuses" (
    "value" text NOT NULL PRIMARY KEY,
    "description" text NOT NULL
);

-- generate_invite_code() normally arrives in the triggers boot phase, which
-- runs AFTER migrations -- so the column default below would not resolve on a
-- fresh install. Seed it here, but only when it is genuinely missing: a plain
-- CREATE OR REPLACE would overwrite whatever body an existing install is on,
-- and the triggers phase only re-applies a file whose digest changed, so that
-- overwrite could outlive the boot that caused it.
DO $do$
BEGIN
    IF to_regprocedure('public.generate_invite_code()') IS NULL THEN
        EXECUTE $fn$
            CREATE FUNCTION public.generate_invite_code() RETURNS text
                LANGUAGE plpgsql
                AS $body$
            DECLARE
                code text;
            BEGIN
                code := lpad(cast(floor(random() * 1000000) as text), 6, '0');
                RETURN code;
            END;
            $body$;
        $fn$;
    END IF;
END
$do$;


-- An invite code is a bearer credential: holding one gets you added to the
-- session lineup and handed a connect string. generate_invite_code() is six
-- digits from random() -- ~20 bits, not cryptographically seeded, and
-- enumerable in a single pass -- which is fine for a code a captain reads out
-- during a match but not for one that grants server access on a public link.
-- Crockford base32 over gen_random_bytes: 10 chars, 50 bits, no ambiguous
-- glyphs. 256 % 32 == 0, so the modulo is unbiased.
CREATE OR REPLACE FUNCTION public.generate_utility_invite_code() RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    AS $fn$
DECLARE
    alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    source bytea := gen_random_bytes(10);
    code text := '';
    i int;
BEGIN
    FOR i IN 0..9 LOOP
        code := code || substr(alphabet, (get_byte(source, i) % 32) + 1, 1);
    END LOOP;
    RETURN code;
END;
$fn$;

CREATE TABLE IF NOT EXISTS "public"."utility_practice_sessions" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    -- RemoveCancelledMatches deletes ended matches after a day. Nullable with
    -- ON DELETE SET NULL so a player's session history (and the lineups they
    -- saved out of it) outlives the match row that hosted it.
    "match_id" uuid,

    "host_steam_id" bigint NOT NULL,
    "team_id" uuid,
    "map_name" text NOT NULL,
    "region" text,
    "collection_id" uuid,

    "status" text NOT NULL DEFAULT 'Starting',
    "invite_code" text NOT NULL DEFAULT public.generate_utility_invite_code(),
    -- Open sessions let anyone with the code in; closed ones are invite,
    -- team-mate or friend only.
    "is_open" boolean NOT NULL DEFAULT false,

    "last_occupied_at" timestamptz,
    "empty_since" timestamptz,
    "expires_at" timestamptz,
    "failure_reason" text,

    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_practice_sessions_match_key" UNIQUE ("match_id"),

    CONSTRAINT "utility_practice_sessions_match_fkey" FOREIGN KEY ("match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_practice_sessions_host_fkey" FOREIGN KEY ("host_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_practice_sessions_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_practice_sessions_collection_fkey" FOREIGN KEY ("collection_id")
        REFERENCES "public"."utility_collections" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_practice_sessions_status_fkey" FOREIGN KEY ("status")
        REFERENCES "public"."e_utility_practice_statuses" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_practice_sessions_region_fkey" FOREIGN KEY ("region")
        REFERENCES "public"."server_regions" ("value") ON UPDATE CASCADE ON DELETE SET NULL
);

-- The real one-live-session-per-user guard. A row-count check in the service
-- races with itself under a double-clicked button; this cannot. Terminal
-- statuses fall out of the index so history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS "utility_practice_sessions_one_live_per_host_idx"
    ON "public"."utility_practice_sessions" ("host_steam_id")
    WHERE "status" IN ('Starting', 'Ready');

CREATE INDEX IF NOT EXISTS "utility_practice_sessions_status_idx"
    ON "public"."utility_practice_sessions" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "utility_practice_sessions_host_idx"
    ON "public"."utility_practice_sessions" ("host_steam_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "utility_practice_sessions_invite_code_idx"
    ON "public"."utility_practice_sessions" ("invite_code")
    WHERE "status" IN ('Starting', 'Ready');

CREATE TABLE IF NOT EXISTS "public"."utility_practice_invites" (
    "utility_practice_session_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "invited_by_steam_id" bigint,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("utility_practice_session_id", "steam_id"),
    CONSTRAINT "utility_practice_invites_session_fkey" FOREIGN KEY ("utility_practice_session_id")
        REFERENCES "public"."utility_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_practice_invites_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_practice_invites_inviter_fkey" FOREIGN KEY ("invited_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "utility_practice_invites_steam_idx"
    ON "public"."utility_practice_invites" ("steam_id");

-- utility_playbooks
CREATE TABLE IF NOT EXISTS "public"."utility_playbooks" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "name" text NOT NULL,
    "description" text,

    -- Keyed on the map name for the same reason utility_lineups is: maps is
    -- UNIQUE (name, type), so a FK would tie an execute to one match type and
    -- fragment the book. Validated by trigger instead.
    "map_name" text NOT NULL,
    "side" text NOT NULL,

    "team_id" uuid,
    "owner_steam_id" bigint NOT NULL,
    "visibility" text NOT NULL DEFAULT 'Private',

    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_playbooks_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_playbooks_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_utility_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_playbooks_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_playbooks_owner_fkey" FOREIGN KEY ("owner_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT "utility_playbooks_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "utility_playbooks_owner_idx"
    ON "public"."utility_playbooks" ("owner_steam_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "utility_playbooks_team_idx"
    ON "public"."utility_playbooks" ("team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "utility_playbooks_public_browse_idx"
    ON "public"."utility_playbooks" ("map_name", "side", "created_at" DESC)
    WHERE "visibility" = 'Public';

CREATE TABLE IF NOT EXISTS "public"."utility_playbook_steps" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "playbook_id" uuid NOT NULL,
    "utility_lineup_id" uuid NOT NULL,

    "step_order" integer NOT NULL DEFAULT 0,
    -- When in the execute this throw happens, measured from the countdown, not
    -- from the round start: a playbook is run on the host's "go", and the
    -- plugin schedules every step off that one instant.
    "offset_ms" integer NOT NULL DEFAULT 0,

    -- Null means nobody has been given this throw yet, which is a real state:
    -- a book is written before the five players are in the server.
    "assigned_steam_id" bigint,
    "note" text,

    "created_at" timestamptz NOT NULL DEFAULT now(),

    -- A surrogate key rather than (playbook_id, utility_lineup_id): the same
    -- lineup can legitimately appear twice in one execute (a molly rethrown
    -- late), so the lineup cannot be part of the identity.
    PRIMARY KEY ("id"),

    -- Two steps must never claim the same slot. DEFERRABLE because Postgres
    -- checks a plain UNIQUE row by row: an in-place reorder
    -- (`SET step_order = step_order + 1`) collides with itself halfway through
    -- the statement unless the check is held to commit.
    CONSTRAINT "utility_playbook_steps_order_key" UNIQUE ("playbook_id", "step_order")
        DEFERRABLE INITIALLY DEFERRED,

    CONSTRAINT "utility_playbook_steps_playbook_fkey" FOREIGN KEY ("playbook_id")
        REFERENCES "public"."utility_playbooks" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_playbook_steps_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_playbook_steps_assigned_fkey" FOREIGN KEY ("assigned_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "utility_playbook_steps_order_chk" CHECK ("step_order" >= 0),
    -- Ten minutes is already far past a round; anything beyond it is a client
    -- sending milliseconds it meant as something else.
    CONSTRAINT "utility_playbook_steps_offset_chk"
        CHECK ("offset_ms" >= 0 AND "offset_ms" <= 600000)
);

CREATE INDEX IF NOT EXISTS "utility_playbook_steps_lineup_idx"
    ON "public"."utility_playbook_steps" ("utility_lineup_id");

ALTER TABLE "public"."utility_practice_sessions"
    ADD COLUMN IF NOT EXISTS "playbook_id" uuid;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'utility_practice_sessions_playbook_fkey'
    ) THEN
        ALTER TABLE "public"."utility_practice_sessions"
            ADD CONSTRAINT "utility_practice_sessions_playbook_fkey"
            FOREIGN KEY ("playbook_id")
            REFERENCES "public"."utility_playbooks" ("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END
$do$;

-- utility_practice_scoring
-- Consecutive successes are kept as a running counter rather than derived,
-- because deriving one means keeping every throw: a practice server produces a
-- result every few seconds per player, and none of those rows is worth storing
-- once it has moved the counter. The whole scoring write path is one upsert,
-- and a streak that is a column stays inside it.
ALTER TABLE "public"."utility_lineup_progress"
    ADD COLUMN IF NOT EXISTS "current_streak" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "best_streak" integer NOT NULL DEFAULT 0;

-- utility_lineup_seed
-- The engine's own starting state for the projectile (m_vInitialPosition /
-- m_vInitialVelocity). Storing it is what lets a throw be re-emitted and
-- reproduced bit for bit later -- a ghost replay, an oracle solver's winning
-- candidate, or a re-simulation against a patched collision mesh.
--
-- Nullable on purpose, and never defaulted: a demo-mined, hand-placed or
-- imported lineup genuinely has no seed, and NULL has to keep meaning "cannot
-- be replayed exactly". A zeroed seed is not a missing one -- it is a grenade
-- launched from the world origin.
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "initial_pos_x" double precision,
    ADD COLUMN IF NOT EXISTS "initial_pos_y" double precision,
    ADD COLUMN IF NOT EXISTS "initial_pos_z" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_x" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_y" double precision,
    ADD COLUMN IF NOT EXISTS "initial_vel_z" double precision;

-- utility_lineup_derivation
-- A demo-mined lineup has two independent readings of where the thrower was
-- looking: the aim recovered from the grenade's own flight, and the view angles
-- the demo recorded for the player at that tick. They should agree to a degree
-- or two. When they do not, one of them is wrong and there is no way to tell
-- which from inside the demo -- so both readings' disagreement is stored rather
-- than silently resolved in favour of either.
--
-- Degrees, signed, shortest arc. NULL means there was nothing to compare
-- against: no position sample close enough to the release, or a lineup that was
-- never mined from a demo at all.
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "view_yaw_delta" double precision,
    ADD COLUMN IF NOT EXISTS "view_pitch_delta" double precision;

-- utility_meta_clusters
-- The meta: which lineups people actually throw, mined out of every demo the
-- platform has kept, independent of whether anyone bothered to save one.
--
-- Two tables rather than one view, because the two questions have different
-- shapes. utility_demo_throws is the fact table -- one row per grenade the miner
-- recovered -- and it only ever grows: a ten-player map produces a few hundred
-- throws, so ten thousand demos is a few million rows, which is nothing to
-- aggregate once and everything to aggregate on every page load. A view over it
-- would re-scan the lot per browse, and PostgreSQL cannot refresh a
-- MATERIALIZED VIEW incrementally -- it can only rebuild the whole thing -- so
-- the aggregate is a plain table the job upserts per map instead.

CREATE TABLE IF NOT EXISTS "public"."utility_demo_throws" (
    -- Keyed on the demo and the grenade rather than a surrogate: re-mining a
    -- demo has to be idempotent, and the demo's own grenade id is what makes
    -- one throw the same throw across two runs.
    "match_map_demo_id" uuid NOT NULL,
    "grenade_id" integer NOT NULL,

    "match_id" uuid,
    "match_map_id" uuid,

    "map_name" text NOT NULL,
    "utility_type" text NOT NULL,
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

    CONSTRAINT "utility_demo_throws_demo_fkey" FOREIGN KEY ("match_map_demo_id")
        REFERENCES "public"."match_map_demos" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_demo_throws_match_fkey" FOREIGN KEY ("match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_demo_throws_match_map_fkey" FOREIGN KEY ("match_map_id")
        REFERENCES "public"."match_maps" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_demo_throws_utility_type_fkey" FOREIGN KEY ("utility_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_demo_throws_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_demo_throws_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_utility_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_demo_throws_throw_strength_fkey" FOREIGN KEY ("throw_strength")
        REFERENCES "public"."e_utility_throw_strengths" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Byte for byte the expression utility_lineups.lineup_bucket uses, so a saved
-- lineup and the throws behind it land in the same bucket. Changing one without
-- the other silently splits every cluster in half.
ALTER TABLE "public"."utility_demo_throws"
    ADD COLUMN IF NOT EXISTS "lineup_bucket" text
    GENERATED ALWAYS AS (
        "map_name" || ':' || "utility_type" || ':' ||
        floor("origin_x" / 64)::int || ',' || floor("origin_y" / 64)::int || ':' ||
        floor("land_x" / 64)::int || ',' || floor("land_y" / 64)::int
    ) STORED;

CREATE INDEX IF NOT EXISTS "utility_demo_throws_bucket_idx"
    ON "public"."utility_demo_throws" ("lineup_bucket");
CREATE INDEX IF NOT EXISTS "utility_demo_throws_map_idx"
    ON "public"."utility_demo_throws" ("map_name", "utility_type");
CREATE INDEX IF NOT EXISTS "utility_demo_throws_thrower_idx"
    ON "public"."utility_demo_throws" ("thrower_steam_id")
    WHERE "thrower_steam_id" IS NOT NULL;

-- Which demos the miner has already been through, and at what version of it.
-- A demo that yielded nothing still gets a row: without one the job would pick
-- the same empty demo up forever.
CREATE TABLE IF NOT EXISTS "public"."utility_demo_mines" (
    "match_map_demo_id" uuid NOT NULL,
    "version" integer NOT NULL,
    "throws" integer NOT NULL DEFAULT 0,
    "failed_reason" text,
    "mined_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("match_map_demo_id"),
    CONSTRAINT "utility_demo_mines_demo_fkey" FOREIGN KEY ("match_map_demo_id")
        REFERENCES "public"."match_map_demos" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "utility_demo_mines_version_idx"
    ON "public"."utility_demo_mines" ("version", "mined_at");

-- One row per cluster: the lineup people actually run, and how many of them.
CREATE TABLE IF NOT EXISTS "public"."utility_meta_lineups" (
    "lineup_bucket" text NOT NULL,

    "map_name" text NOT NULL,
    "utility_type" text NOT NULL,
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

    CONSTRAINT "utility_meta_lineups_utility_type_fkey" FOREIGN KEY ("utility_type")
        REFERENCES "public"."e_utility_types" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_meta_lineups_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "utility_meta_lineups_technique_fkey" FOREIGN KEY ("technique")
        REFERENCES "public"."e_utility_techniques" ("value") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "utility_meta_lineups_browse_idx"
    ON "public"."utility_meta_lineups" ("map_name", "utility_type", "throwers" DESC);

-- utility_drift_scans
-- Map-patch drift: which stored lineups a new collision mesh moved.
--
-- Two tables because the run and the verdict have different lifetimes. A scan
-- is a job with a summary somebody reads once; a verdict is per lineup and is
-- what the library screen joins against to put "this smoke moved 90 units on
-- the last patch" next to the lineup itself.
--
-- NOTHING HERE STORES A COORDINATE. The simulator's endpoints are only
-- meaningful as a difference -- the physics model is unfitted, so both runs
-- carry the same error and only the gap between them survives it. Persisting
-- the points would put a number on a screen that reads as "where your utility
-- lands", which it is not, so only the distances are kept.

CREATE TABLE IF NOT EXISTS "public"."utility_drift_scans" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "map_name" text NOT NULL,
    -- Mesh revisions as the parser names them (a jsDelivr tag, owner/repo@tag,
    -- or an http base). NULL means "the revision the parser is pinned to",
    -- which is the useful spelling for `to` straight after a deploy.
    "from_revision" text,
    "to_revision" text,

    "status" text NOT NULL DEFAULT 'Pending',
    "failure_reason" text,

    -- How many lineups the scan set out to judge, then the verdict tally.
    "lineups" integer NOT NULL DEFAULT 0,
    "scanned" integer NOT NULL DEFAULT 0,
    "unchanged" integer NOT NULL DEFAULT 0,
    "moved" integer NOT NULL DEFAULT 0,
    "broken" integer NOT NULL DEFAULT 0,
    "unsimulatable" integer NOT NULL DEFAULT 0,
    "max_distance" double precision,

    "requested_by_steam_id" bigint,

    "started_at" timestamptz,
    "finished_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_drift_scans_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "utility_drift_scans_status_chk"
        CHECK ("status" IN ('Pending', 'Running', 'Finished', 'Failed'))
);

CREATE INDEX IF NOT EXISTS "utility_drift_scans_map_idx"
    ON "public"."utility_drift_scans" ("map_name", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "public"."utility_drift_results" (
    "utility_drift_scan_id" uuid NOT NULL,
    "utility_lineup_id" uuid NOT NULL,

    -- The parser's spellings, kept verbatim so a verdict cannot mean one thing
    -- here and another in the service that produced it. 'unsimulatable' is a
    -- real answer -- a lineup with no recorded seed cannot be re-flown, and
    -- that is not the same as unchanged.
    "verdict" text NOT NULL,
    "severity" text,
    "reason" text,

    -- How far the endpoint moved, source units. NULL unless BOTH flights
    -- resolved: the gap between a landing and a grenade that fell out of the
    -- map is not a distance that means anything.
    "distance" double precision,
    "distance_xy" double precision,
    "distance_z" double precision,

    "created_at" timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY ("utility_drift_scan_id", "utility_lineup_id"),

    CONSTRAINT "utility_drift_results_scan_fkey" FOREIGN KEY ("utility_drift_scan_id")
        REFERENCES "public"."utility_drift_scans" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_drift_results_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT "utility_drift_results_verdict_chk"
        CHECK ("verdict" IN ('unchanged', 'moved', 'broken', 'unsimulatable')),
    CONSTRAINT "utility_drift_results_severity_chk"
        CHECK ("severity" IS NULL OR "severity" IN ('minor', 'major'))
);

CREATE INDEX IF NOT EXISTS "utility_drift_results_lineup_idx"
    ON "public"."utility_drift_results" ("utility_lineup_id");
CREATE INDEX IF NOT EXISTS "utility_drift_results_verdict_idx"
    ON "public"."utility_drift_results" ("utility_drift_scan_id", "verdict");

-- utility_confidence_and_forks
-- confidence defaulted to 'exact', which is only true of a throw a server
-- watched. origin_source is not insertable by any non-admin role and defaults
-- to 'editor', so a lineup typed into the web editor arrived claiming to be an
-- engine-accurate recording while carrying hand-entered coordinates and no
-- physics seed. 'exact' is half of the plugin's IsExactlyReplayable() gate, so
-- the most trusting value in the enum was the one you got by saying nothing.
--
-- The default becomes the weakest claim; the trigger in
-- hasura/triggers/utility_lineups.sql is what makes it an invariant rather than a
-- convention, because every path that writes confidence explicitly (ingest,
-- mining, an admin insert, a fork) bypasses the default entirely.
ALTER TABLE "public"."utility_lineups"
    ALTER COLUMN "confidence" SET DEFAULT 'low';

-- Rows already written under the old default. 'derived' for a demo-mined row
-- and 'low' for everything else mirrors what the trigger will now enforce.
UPDATE "public"."utility_lineups"
   SET "confidence" = CASE
           WHEN "origin_source" = 'demo' THEN 'derived'
           ELSE 'low'
       END
 WHERE "confidence" = 'exact'
   AND "origin_source" NOT IN ('plugin', 'fork')
   AND (
       "initial_pos_x" IS NULL OR "initial_pos_y" IS NULL OR "initial_pos_z" IS NULL
       OR "initial_vel_x" IS NULL OR "initial_vel_y" IS NULL OR "initial_vel_z" IS NULL
   );

-- A fork is a copy of somebody else's lineup into your own library. It keeps
-- the geometry and drops the original's provenance, so this column IS the
-- fork's provenance: without it a forked row is indistinguishable from one
-- drawn by hand, and the original author's credit disappears silently.
--
-- ON DELETE SET NULL rather than CASCADE: deleting the lineup you copied from
-- must not delete everyone's copies of it.
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "forked_from_utility_lineup_id" uuid;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'utility_lineups_forked_from_fkey'
    ) THEN
        ALTER TABLE "public"."utility_lineups"
            ADD CONSTRAINT "utility_lineups_forked_from_fkey"
            FOREIGN KEY ("forked_from_utility_lineup_id")
            REFERENCES "public"."utility_lineups" ("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS "utility_lineups_forked_from_idx"
    ON "public"."utility_lineups" ("forked_from_utility_lineup_id")
    WHERE "forked_from_utility_lineup_id" IS NOT NULL;

-- utility_lineup_repairs
-- A drift scan says a lineup moved; the solver can find a throw that lands on a
-- point. This table is the wire between them.
--
-- It exists because the two halves never meet in one request. The solve is
-- issued over RCON and answers immediately, and the lineup it finds arrives
-- minutes later through POST /utility/ingest as a brand new row with no idea what
-- it was for. Without a record of the ask, the repaired lineup and the drifted
-- one are two unrelated rows and nothing is self-healing.
--
-- The repair is always a NEW lineup, never an edit of the drifted one. Rewriting
-- the original's geometry in place would silently invalidate everything hanging
-- off it: utility_lineup_progress.mastered_at means "five throws inside 96u of THIS
-- landing point", votes and favourites are opinions about a throw that would no
-- longer exist, and the utility_drift_results verdict would become a statement
-- about coordinates that had been overwritten. None of those rows carry a
-- geometry version, so none of them could be partially kept.
CREATE TABLE IF NOT EXISTS "public"."utility_lineup_repairs" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "utility_lineup_id" uuid NOT NULL,
    -- The scan whose verdict justified the repair. SET NULL rather than CASCADE:
    -- pruning old scans must not erase the fact that a repair happened.
    "utility_drift_scan_id" uuid,
    "utility_practice_session_id" uuid,

    "requested_by_steam_id" bigint NOT NULL,

    "status" text NOT NULL DEFAULT 'Requested',

    -- Copied off the verdict rather than joined back to it, for the same reason
    -- the scan is nullable: the number is what a reader wants next to the
    -- repair, and the scan it came from is allowed to be deleted.
    "drift_distance" double precision,

    "repaired_utility_lineup_id" uuid,

    -- A solve is up to 300 grenades over two minutes. Past this window the
    -- lineup that arrives is somebody's own throw, not the answer to this ask,
    -- and claiming it would attribute a stranger's smoke to a repair.
    "expires_at" timestamptz NOT NULL,

    "created_at" timestamptz NOT NULL DEFAULT now(),
    "repaired_at" timestamptz,

    PRIMARY KEY ("id"),

    CONSTRAINT "utility_lineup_repairs_lineup_fkey" FOREIGN KEY ("utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "utility_lineup_repairs_scan_fkey" FOREIGN KEY ("utility_drift_scan_id")
        REFERENCES "public"."utility_drift_scans" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineup_repairs_session_fkey" FOREIGN KEY ("utility_practice_session_id")
        REFERENCES "public"."utility_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "utility_lineup_repairs_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    -- The repaired lineup is the caller's own row in their own library, and
    -- deleting it must leave the repair's history standing.
    CONSTRAINT "utility_lineup_repairs_repaired_fkey" FOREIGN KEY ("repaired_utility_lineup_id")
        REFERENCES "public"."utility_lineups" ("id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "utility_lineup_repairs_status_chk"
        CHECK ("status" IN ('Requested', 'Repaired', 'Expired'))
);

-- One open ask per person per lineup. Without it a double-clicked button leaves
-- two Requested rows and the second one can never be claimed -- the plugin only
-- posts one lineup.
CREATE UNIQUE INDEX IF NOT EXISTS "utility_lineup_repairs_open_idx"
    ON "public"."utility_lineup_repairs" ("utility_lineup_id", "requested_by_steam_id")
    WHERE "status" = 'Requested';

CREATE INDEX IF NOT EXISTS "utility_lineup_repairs_lineup_idx"
    ON "public"."utility_lineup_repairs" ("utility_lineup_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "utility_lineup_repairs_requested_by_idx"
    ON "public"."utility_lineup_repairs" ("requested_by_steam_id", "created_at" DESC);

-- utility_miss_offsets
-- Every practice throw already reports where the grenade landed and the
-- scoring path already reduces it to a distance. The direction was thrown
-- away, and the direction is the only half of it that can be coached: "most
-- people land this one short" is advice, "most people land this one 74 units
-- away" is not.
--
-- Running sums rather than a row per throw. A practice server produces a
-- result every few seconds per player, so per-throw rows are an unbounded
-- table that would need a retention policy and a reaper to stay one; four
-- columns join the upsert the scoring path already writes and cost it no
-- extra statement.
--
-- Per PLAYER rather than per lineup, and that is the whole reason they live
-- on this table: the pattern is read as a mean of player means, so somebody
-- who drills one lineup two hundred times contributes exactly one opinion --
-- the same as somebody who threw it ten times. Summed on the lineup, one
-- obsessive would BE the pattern everybody else is shown.
--
-- Not exposed to any insert or update permission, for the same reason the
-- streak columns are not: these are the API's measurement of a throw, and a
-- role that could write them could write itself a coaching pattern.
ALTER TABLE "public"."utility_lineup_progress"
    ADD COLUMN IF NOT EXISTS "miss_samples" integer NOT NULL DEFAULT 0,
    -- Source units along the throw's own axes, signed:
    -- +along = long, +lateral = right of the throw, +vertical = high.
    ADD COLUMN IF NOT EXISTS "miss_along_sum" double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "miss_lateral_sum" double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "miss_vertical_sum" double precision NOT NULL DEFAULT 0;

-- utility_lineup_difficulty
-- What everybody's practice says about a lineup, kept on the lineup so that
-- "is this a five-minute learn or a week's work" is one column read rather
-- than an aggregate over every progress row the lineup has ever collected.
--
-- practice_players counts progress rows that have at least one attempt, not
-- rows: a row is created the moment a lineup is opened, and a lineup nobody
-- has thrown at is not a lineup three people found hard.
ALTER TABLE "public"."utility_lineups"
    ADD COLUMN IF NOT EXISTS "practice_players" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "practice_attempts" integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "practice_successes" integer NOT NULL DEFAULT 0;

-- Backfill from the progress rows that already exist. Triggers are off for
-- the duration because tbiu_utility_lineups re-validates the entire row on every
-- UPDATE -- a lineup on a map that has since been removed from public.maps
-- would abort the migration rather than be counted, and a backfill has no
-- business restamping updated_at either.
--
-- DISABLE TRIGGER USER rather than naming tbiu_utility_lineups: on a cold start
-- this migration runs before hasura/triggers is applied, so the trigger it
-- would name does not exist yet.
ALTER TABLE "public"."utility_lineups" DISABLE TRIGGER USER;

UPDATE "public"."utility_lineups" l
   SET "practice_players" = agg.players,
       "practice_attempts" = agg.attempts,
       "practice_successes" = agg.successes
  FROM (
         SELECT p.utility_lineup_id,
                count(*) FILTER (WHERE p.attempts > 0)::int AS players,
                COALESCE(sum(p.attempts), 0)::int AS attempts,
                COALESCE(sum(p.successes), 0)::int AS successes
           FROM public.utility_lineup_progress p
          GROUP BY p.utility_lineup_id
       ) agg
 WHERE agg.utility_lineup_id = l.id;

ALTER TABLE "public"."utility_lineups" ENABLE TRIGGER USER;
