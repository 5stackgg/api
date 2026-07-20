-- The base URL an admin pasted into Detect (e.g. https://inventory.example.gg).
-- Only `remote_entry_url` was persisted before, and it cannot be reversed into
-- this: the manifest's `remoteEntry` may be absolute, and a plugin hosted under
-- a subpath leaves no way to tell which part of the path was the base.
ALTER TABLE "public"."custom_pages"
  ADD COLUMN IF NOT EXISTS "manifest_url" text;
