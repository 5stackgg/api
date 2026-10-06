create schema if not exists "migration_hashes";

CREATE TABLE IF NOT EXISTS "migration_hashes"."hashes" ("name" text NOT NULL, "hash" text NOT NULL, PRIMARY KEY ("name") );
