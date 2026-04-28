alter table "public"."game_server_nodes" add column if not exists "gpu_info" jsonb
 null;
