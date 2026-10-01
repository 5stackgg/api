DROP TRIGGER IF EXISTS "set_public_server_migrations_updated_at" ON "public"."server_migrations";
CREATE TRIGGER "set_public_server_migrations_updated_at"
BEFORE UPDATE ON "public"."server_migrations"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
