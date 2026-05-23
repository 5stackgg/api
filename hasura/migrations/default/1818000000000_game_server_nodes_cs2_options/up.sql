alter table "public"."game_server_nodes" add column if not exists "cs2_video_settings" jsonb
 not null default '{}'::jsonb;
