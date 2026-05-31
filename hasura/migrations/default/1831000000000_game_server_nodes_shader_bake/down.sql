alter table "public"."game_server_nodes"
  drop column if exists "shader_bake_status_history",
  drop column if exists "shader_bake_progress_stage",
  drop column if exists "shader_bake_progress",
  drop column if exists "shader_bake_status";
