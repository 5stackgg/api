alter table "public"."game_server_nodes" add column "supports_cpu_pinning" boolean
 not null default 'false';

alter table "public"."game_server_nodes" add column "supports_low_latency" boolean
 not null default 'false';
