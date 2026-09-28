CREATE TABLE IF NOT EXISTS "public"."map_asset_builds" (
    "build_id" text NOT NULL,
    "status" text NOT NULL DEFAULT 'Pending',
    "started_at" timestamptz,
    "finished_at" timestamptz,
    "manifest" text,
    "maps" jsonb,
    "failed" jsonb,
    "failed_view" jsonb,
    "error" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("build_id"),
    CONSTRAINT "map_asset_builds_status_check"
        CHECK ("status" IN ('Pending', 'Building', 'Published', 'Partial', 'Failed'))
);
