CREATE TABLE IF NOT EXISTS "public"."nade_playbooks" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "name" text NOT NULL,
    "description" text,

    -- Keyed on the map name for the same reason nade_lineups is: maps is
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

    CONSTRAINT "nade_playbooks_side_fkey" FOREIGN KEY ("side")
        REFERENCES "public"."e_sides" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_playbooks_visibility_fkey" FOREIGN KEY ("visibility")
        REFERENCES "public"."e_nade_visibility" ("value") ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT "nade_playbooks_team_fkey" FOREIGN KEY ("team_id")
        REFERENCES "public"."teams" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_playbooks_owner_fkey" FOREIGN KEY ("owner_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT "nade_playbooks_team_scope_chk"
        CHECK ("visibility" <> 'Team' OR "team_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "nade_playbooks_owner_idx"
    ON "public"."nade_playbooks" ("owner_steam_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "nade_playbooks_team_idx"
    ON "public"."nade_playbooks" ("team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "nade_playbooks_public_browse_idx"
    ON "public"."nade_playbooks" ("map_name", "side", "created_at" DESC)
    WHERE "visibility" = 'Public';

CREATE TABLE IF NOT EXISTS "public"."nade_playbook_steps" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "playbook_id" uuid NOT NULL,
    "nade_lineup_id" uuid NOT NULL,

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

    -- A surrogate key rather than (playbook_id, nade_lineup_id): the same
    -- lineup can legitimately appear twice in one execute (a molly rethrown
    -- late), so the lineup cannot be part of the identity.
    PRIMARY KEY ("id"),

    -- Two steps must never claim the same slot. DEFERRABLE because Postgres
    -- checks a plain UNIQUE row by row: an in-place reorder
    -- (`SET step_order = step_order + 1`) collides with itself halfway through
    -- the statement unless the check is held to commit.
    CONSTRAINT "nade_playbook_steps_order_key" UNIQUE ("playbook_id", "step_order")
        DEFERRABLE INITIALLY DEFERRED,

    CONSTRAINT "nade_playbook_steps_playbook_fkey" FOREIGN KEY ("playbook_id")
        REFERENCES "public"."nade_playbooks" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_playbook_steps_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_playbook_steps_assigned_fkey" FOREIGN KEY ("assigned_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "nade_playbook_steps_order_chk" CHECK ("step_order" >= 0),
    -- Ten minutes is already far past a round; anything beyond it is a client
    -- sending milliseconds it meant as something else.
    CONSTRAINT "nade_playbook_steps_offset_chk"
        CHECK ("offset_ms" >= 0 AND "offset_ms" <= 600000)
);

CREATE INDEX IF NOT EXISTS "nade_playbook_steps_lineup_idx"
    ON "public"."nade_playbook_steps" ("nade_lineup_id");

ALTER TABLE "public"."nade_practice_sessions"
    ADD COLUMN IF NOT EXISTS "playbook_id" uuid;

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'nade_practice_sessions_playbook_fkey'
    ) THEN
        ALTER TABLE "public"."nade_practice_sessions"
            ADD CONSTRAINT "nade_practice_sessions_playbook_fkey"
            FOREIGN KEY ("playbook_id")
            REFERENCES "public"."nade_playbooks" ("id")
            ON UPDATE CASCADE ON DELETE SET NULL;
    END IF;
END
$do$;
