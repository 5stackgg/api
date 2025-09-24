alter table "public"."game_server_nodes" add column if not exists "gpu" boolean
 not null default 'false';

alter table "public"."game_server_nodes" add column if not exists "cpu_cores_per_socket" integer
 null;

alter table "public"."game_server_nodes" add column if not exists "cpu_threads_per_core" integer
 null;
