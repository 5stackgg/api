CREATE TABLE IF NOT EXISTS "public"."custom_pages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "icon" text,
  "remote_entry_url" text NOT NULL,
  "remote_scope" text NOT NULL,
  "exposed_module" text NOT NULL DEFAULT './App',
  "required_role" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "is_default" boolean NOT NULL DEFAULT false,
  "nav_group" text,
  "nav_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "custom_pages_slug_key" UNIQUE ("slug"),
  CONSTRAINT "custom_pages_required_role_fkey"
    FOREIGN KEY ("required_role") REFERENCES "public"."e_player_roles" ("value")
    ON UPDATE CASCADE ON DELETE SET NULL
);

-- The slug is the URL segment (/apps/<slug>); enforce a URL-safe shape so a bad
-- row can never produce an unroutable path.
ALTER TABLE "public"."custom_pages"
  ADD CONSTRAINT "custom_pages_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

CREATE UNIQUE INDEX IF NOT EXISTS "custom_pages_single_default_idx"
  ON "public"."custom_pages" ("is_default") WHERE "is_default";

CREATE INDEX IF NOT EXISTS "custom_pages_enabled_nav_order_idx"
  ON "public"."custom_pages" ("enabled", "nav_order");
