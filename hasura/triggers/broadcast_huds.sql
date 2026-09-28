DROP TRIGGER IF EXISTS "set_public_broadcast_huds_updated_at" ON "public"."broadcast_huds";
CREATE TRIGGER "set_public_broadcast_huds_updated_at"
BEFORE UPDATE ON "public"."broadcast_huds"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
