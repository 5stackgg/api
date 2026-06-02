alter table "public"."game_server_nodes"
  add column if not exists "gpu_streaming_enabled" boolean not null default true,
  add column if not exists "gpu_demos_enabled" boolean not null default true,
  add column if not exists "gpu_rendering_enabled" boolean not null default true;
