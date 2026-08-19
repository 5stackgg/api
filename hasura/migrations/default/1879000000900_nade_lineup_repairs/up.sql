-- A drift scan says a lineup moved; the solver can find a throw that lands on a
-- point. This table is the wire between them.
--
-- It exists because the two halves never meet in one request. The solve is
-- issued over RCON and answers immediately, and the lineup it finds arrives
-- minutes later through POST /nades/ingest as a brand new row with no idea what
-- it was for. Without a record of the ask, the repaired lineup and the drifted
-- one are two unrelated rows and nothing is self-healing.
--
-- The repair is always a NEW lineup, never an edit of the drifted one. Rewriting
-- the original's geometry in place would silently invalidate everything hanging
-- off it: nade_lineup_progress.mastered_at means "five throws inside 96u of THIS
-- landing point", votes and favourites are opinions about a throw that would no
-- longer exist, and the nade_drift_results verdict would become a statement
-- about coordinates that had been overwritten. None of those rows carry a
-- geometry version, so none of them could be partially kept.
CREATE TABLE IF NOT EXISTS "public"."nade_lineup_repairs" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),

    "nade_lineup_id" uuid NOT NULL,
    -- The scan whose verdict justified the repair. SET NULL rather than CASCADE:
    -- pruning old scans must not erase the fact that a repair happened.
    "nade_drift_scan_id" uuid,
    "nade_practice_session_id" uuid,

    "requested_by_steam_id" bigint NOT NULL,

    "status" text NOT NULL DEFAULT 'Requested',

    -- Copied off the verdict rather than joined back to it, for the same reason
    -- the scan is nullable: the number is what a reader wants next to the
    -- repair, and the scan it came from is allowed to be deleted.
    "drift_distance" double precision,

    "repaired_nade_lineup_id" uuid,

    -- A solve is up to 300 grenades over two minutes. Past this window the
    -- lineup that arrives is somebody's own throw, not the answer to this ask,
    -- and claiming it would attribute a stranger's smoke to a repair.
    "expires_at" timestamptz NOT NULL,

    "created_at" timestamptz NOT NULL DEFAULT now(),
    "repaired_at" timestamptz,

    PRIMARY KEY ("id"),

    CONSTRAINT "nade_lineup_repairs_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_lineup_repairs_scan_fkey" FOREIGN KEY ("nade_drift_scan_id")
        REFERENCES "public"."nade_drift_scans" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_lineup_repairs_session_fkey" FOREIGN KEY ("nade_practice_session_id")
        REFERENCES "public"."nade_practice_sessions" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "nade_lineup_repairs_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE CASCADE,
    -- The repaired lineup is the caller's own row in their own library, and
    -- deleting it must leave the repair's history standing.
    CONSTRAINT "nade_lineup_repairs_repaired_fkey" FOREIGN KEY ("repaired_nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "nade_lineup_repairs_status_chk"
        CHECK ("status" IN ('Requested', 'Repaired', 'Expired'))
);

-- One open ask per person per lineup. Without it a double-clicked button leaves
-- two Requested rows and the second one can never be claimed -- the plugin only
-- posts one lineup.
CREATE UNIQUE INDEX IF NOT EXISTS "nade_lineup_repairs_open_idx"
    ON "public"."nade_lineup_repairs" ("nade_lineup_id", "requested_by_steam_id")
    WHERE "status" = 'Requested';

CREATE INDEX IF NOT EXISTS "nade_lineup_repairs_lineup_idx"
    ON "public"."nade_lineup_repairs" ("nade_lineup_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "nade_lineup_repairs_requested_by_idx"
    ON "public"."nade_lineup_repairs" ("requested_by_steam_id", "created_at" DESC);
