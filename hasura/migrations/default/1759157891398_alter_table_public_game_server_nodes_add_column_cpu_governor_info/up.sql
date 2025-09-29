alter table "public"."game_server_nodes" add column if not exists "cpu_governor_info" jsonb
 null;