ALTER TABLE "public"."utility_drift_scans"
    ADD COLUMN IF NOT EXISTS "caveats" jsonb;
