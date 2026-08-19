ALTER TABLE "public"."servers"
    DROP COLUMN IF EXISTS "plugins_checked_at";

ALTER TABLE "public"."servers"
    DROP COLUMN IF EXISTS "loaded_plugins";
