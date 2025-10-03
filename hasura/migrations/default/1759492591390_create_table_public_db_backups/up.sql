CREATE TABLE IF NOT EXISTS "public"."db_backups" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "size" integer NOT NULL, "name" text NOT NULL, "created_at" timestamptz NOT NULL, PRIMARY KEY ("id") );
