CREATE TABLE IF NOT EXISTS "public"."e_nade_practice_statuses" (
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
CREATE OR REPLACE FUNCTION public.generate_nade_invite_code() RETURNS text
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

CREATE TABLE IF NOT EXISTS "public"."nade_practice_sessions" (
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
    "invite_code" text NOT NULL DEFAULT public.generate_nade_invite_code(),
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

    CONSTRAINT "nade_practice_sessions_match_key" UNIQUE ("match_id"),

    CONSTRAINT "nade_practice_sessions_match_fkey" FOREIGN KEY ("match_id")
        REFERENCES "public"."matches" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_practice_sessions_host_fkey" FOREIGN KEY ("host_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_practice_sessions_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_practice_sessions_collection_fkey" FOREIGN KEY ("collection_id")
        REFERENCES "public"."nade_collections" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_practice_sessions_status_fkey" FOREIGN KEY ("status")
        REFERENCES "public"."e_nade_practice_statuses" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_practice_sessions_region_fkey" FOREIGN KEY ("region")
        REFERENCES "public"."server_regions" ("value") ON UPDATE CASCADE ON DELETE SET NULL
);

-- The real one-live-session-per-user guard. A row-count check in the service
-- races with itself under a double-clicked button; this cannot. Terminal
-- statuses fall out of the index so history accumulates freely.
CREATE UNIQUE INDEX IF NOT EXISTS "nade_practice_sessions_one_live_per_host_idx"
    ON "public"."nade_practice_sessions" ("host_steam_id")
    WHERE "status" IN ('Starting', 'Ready');

CREATE INDEX IF NOT EXISTS "nade_practice_sessions_status_idx"
    ON "public"."nade_practice_sessions" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "nade_practice_sessions_host_idx"
    ON "public"."nade_practice_sessions" ("host_steam_id", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "nade_practice_sessions_invite_code_idx"
    ON "public"."nade_practice_sessions" ("invite_code")
    WHERE "status" IN ('Starting', 'Ready');

CREATE TABLE IF NOT EXISTS "public"."nade_practice_invites" (
    "nade_practice_session_id" uuid NOT NULL,
    "steam_id" bigint NOT NULL,
    "invited_by_steam_id" bigint,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("nade_practice_session_id", "steam_id"),
    CONSTRAINT "nade_practice_invites_session_fkey" FOREIGN KEY ("nade_practice_session_id")
        REFERENCES "public"."nade_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_practice_invites_player_fkey" FOREIGN KEY ("steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_practice_invites_inviter_fkey" FOREIGN KEY ("invited_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "nade_practice_invites_steam_idx"
    ON "public"."nade_practice_invites" ("steam_id");
