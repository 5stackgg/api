DROP TRIGGER IF EXISTS "set_public_custom_pages_updated_at" ON "public"."custom_pages";
CREATE TRIGGER "set_public_custom_pages_updated_at"
BEFORE UPDATE ON "public"."custom_pages"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
