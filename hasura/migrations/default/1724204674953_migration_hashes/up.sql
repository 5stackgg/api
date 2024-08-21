create schema "migration_hashes";

CREATE TABLE "migration_hashes"."hashes" ("name" text NOT NULL, "hash" text NOT NULL, PRIMARY KEY ("name") );
