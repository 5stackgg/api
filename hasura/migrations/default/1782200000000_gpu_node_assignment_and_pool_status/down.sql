alter table "public"."clip_render_jobs"
  alter column "user_steam_id" set not null;

alter table "public"."clip_render_jobs"
  drop constraint if exists "clip_render_jobs_game_server_node_id_fkey";
drop index if exists "public"."clip_render_jobs_game_server_node_id_idx";
alter table "public"."clip_render_jobs"
  drop column if exists "game_server_node_id";

alter table "public"."match_demo_sessions"
  drop constraint if exists "match_demo_sessions_game_server_node_id_fkey";
drop index if exists "public"."match_demo_sessions_game_server_node_id_idx";
alter table "public"."match_demo_sessions"
  drop column if exists "game_server_node_id";

alter table "public"."match_streams"
  drop constraint if exists "match_streams_game_server_node_id_fkey";
drop index if exists "public"."match_streams_game_server_node_id_idx";
alter table "public"."match_streams"
  drop column if exists "game_server_node_id";
