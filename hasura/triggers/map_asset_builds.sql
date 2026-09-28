DROP TRIGGER IF EXISTS "set_public_map_asset_builds_updated_at" ON "public"."map_asset_builds";
CREATE TRIGGER "set_public_map_asset_builds_updated_at"
BEFORE UPDATE ON "public"."map_asset_builds"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
