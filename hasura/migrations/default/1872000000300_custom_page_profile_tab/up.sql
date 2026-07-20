-- Nullable text, not a boolean: null means "no tab", and a non-null value IS the
-- tab's label. One column carries both the opt-in and the wording, so an admin
-- can rename a plugin's profile tab without a code change.
ALTER TABLE "public"."custom_pages"
  ADD COLUMN IF NOT EXISTS "profile_tab_label" text;
