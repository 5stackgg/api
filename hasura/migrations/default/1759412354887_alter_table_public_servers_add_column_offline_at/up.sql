alter table "public"."servers" add column if not exists "offline_at" timestamptz
 null;

 alter table "public"."game_server_nodes" add column if not exists "offline_at" timestamptz
 null;
