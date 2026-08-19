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
-- the points would put a number on a screen that reads as "where your nade
-- lands", which it is not, so only the distances are kept.

CREATE TABLE IF NOT EXISTS "public"."nade_drift_scans" (
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

    CONSTRAINT "nade_drift_scans_requested_by_fkey" FOREIGN KEY ("requested_by_steam_id")
        REFERENCES "public"."players" ("steam_id") ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT "nade_drift_scans_status_chk"
        CHECK ("status" IN ('Pending', 'Running', 'Finished', 'Failed'))
);

CREATE INDEX IF NOT EXISTS "nade_drift_scans_map_idx"
    ON "public"."nade_drift_scans" ("map_name", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "public"."nade_drift_results" (
    "nade_drift_scan_id" uuid NOT NULL,
    "nade_lineup_id" uuid NOT NULL,

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

    PRIMARY KEY ("nade_drift_scan_id", "nade_lineup_id"),

    CONSTRAINT "nade_drift_results_scan_fkey" FOREIGN KEY ("nade_drift_scan_id")
        REFERENCES "public"."nade_drift_scans" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "nade_drift_results_lineup_fkey" FOREIGN KEY ("nade_lineup_id")
        REFERENCES "public"."nade_lineups" ("id") ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT "nade_drift_results_verdict_chk"
        CHECK ("verdict" IN ('unchanged', 'moved', 'broken', 'unsimulatable')),
    CONSTRAINT "nade_drift_results_severity_chk"
        CHECK ("severity" IS NULL OR "severity" IN ('minor', 'major'))
);

CREATE INDEX IF NOT EXISTS "nade_drift_results_lineup_idx"
    ON "public"."nade_drift_results" ("nade_lineup_id");
CREATE INDEX IF NOT EXISTS "nade_drift_results_verdict_idx"
    ON "public"."nade_drift_results" ("nade_drift_scan_id", "verdict");
