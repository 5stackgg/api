alter table "public"."servers" add column IF NOT EXISTS "updated_at" timestamptz
 null default now();

CREATE OR REPLACE FUNCTION "public"."set_current_timestamp_updated_at"()
RETURNS TRIGGER AS $$
DECLARE
  _new record;
BEGIN
  _new := NEW;
  _new."updated_at" = NOW();
  RETURN _new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "set_public_servers_updated_at" ON "public"."servers";

CREATE TRIGGER "set_public_servers_updated_at"
BEFORE UPDATE ON "public"."servers"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
COMMENT ON TRIGGER "set_public_servers_updated_at" ON "public"."servers"
IS 'trigger to set value of column "updated_at" to current timestamp on row update';
