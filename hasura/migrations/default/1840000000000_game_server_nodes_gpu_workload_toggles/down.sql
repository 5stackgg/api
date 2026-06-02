alter table "public"."game_server_nodes"
  drop column if exists "gpu_rendering_enabled",
  drop column if exists "gpu_demos_enabled",
  drop column if exists "gpu_streaming_enabled";
