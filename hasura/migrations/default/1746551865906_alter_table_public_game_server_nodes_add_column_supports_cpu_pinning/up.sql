alter table "public"."game_server_nodes" add column if not exists "supports_cpu_pinning" boolean
 not null default 'false';

alter table "public"."game_server_nodes" add column if not exists "supports_low_latency" boolean
 not null default 'false';
