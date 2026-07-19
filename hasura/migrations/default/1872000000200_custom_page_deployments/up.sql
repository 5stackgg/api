ALTER TABLE "public"."custom_pages"
  ADD COLUMN IF NOT EXISTS "deployments" jsonb NOT NULL DEFAULT '[]'::jsonb;
