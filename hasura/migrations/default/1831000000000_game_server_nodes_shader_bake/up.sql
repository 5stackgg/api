alter table "public"."game_server_nodes"
  add column if not exists "shader_bake_status" text,
  add column if not exists "shader_bake_progress" numeric,
  add column if not exists "shader_bake_progress_stage" text,
  add column if not exists "shader_bake_status_history" jsonb not null default '[]'::jsonb;
