alter table "public"."servers" add column IF NOT EXISTS "updated_at" timestamptz
 null default now();

-- set_current_timestamp_updated_at() lives in
-- hasura/functions/set_current_timestamp_updated_at.sql and the
-- set_public_servers_updated_at trigger in hasura/triggers/servers.sql
-- (both re-applied on boot, after migrations).
