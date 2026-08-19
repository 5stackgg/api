-- What the server reported actually loaded, as opposed to what is on disk.
-- Files being present is not the same as a plugin loading: a CS2 update breaks
-- signatures, a build targets the other framework, a config is malformed. All
-- of those look identical on the filesystem and only differ here.
ALTER TABLE "public"."servers"
    ADD COLUMN IF NOT EXISTS "loaded_plugins" jsonb;

ALTER TABLE "public"."servers"
    ADD COLUMN IF NOT EXISTS "plugins_checked_at" timestamptz;
