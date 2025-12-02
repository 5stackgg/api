alter table "public"."game_server_nodes" add column if not exists "cpu_frequency_info" jsonb
 null;
