alter table "public"."match_streams"
  add column if not exists "game_server_node_id" text null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'match_streams_game_server_node_id_fkey'
      and table_name = 'match_streams'
  ) then
    alter table "public"."match_streams"
      add constraint "match_streams_game_server_node_id_fkey"
      foreign key ("game_server_node_id")
      references "public"."game_server_nodes" ("id")
      on update cascade on delete set null;
  end if;
end $$;

create index if not exists "match_streams_game_server_node_id_idx"
  on "public"."match_streams" ("game_server_node_id")
  where "game_server_node_id" is not null;


alter table "public"."match_demo_sessions"
  add column if not exists "game_server_node_id" text null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'match_demo_sessions_game_server_node_id_fkey'
      and table_name = 'match_demo_sessions'
  ) then
    alter table "public"."match_demo_sessions"
      add constraint "match_demo_sessions_game_server_node_id_fkey"
      foreign key ("game_server_node_id")
      references "public"."game_server_nodes" ("id")
      on update cascade on delete set null;
  end if;
end $$;

create index if not exists "match_demo_sessions_game_server_node_id_idx"
  on "public"."match_demo_sessions" ("game_server_node_id")
  where "game_server_node_id" is not null;


alter table "public"."clip_render_jobs"
  add column if not exists "game_server_node_id" text null;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'clip_render_jobs_game_server_node_id_fkey'
      and table_name = 'clip_render_jobs'
  ) then
    alter table "public"."clip_render_jobs"
      add constraint "clip_render_jobs_game_server_node_id_fkey"
      foreign key ("game_server_node_id")
      references "public"."game_server_nodes" ("id")
      on update cascade on delete set null;
  end if;
end $$;

create index if not exists "clip_render_jobs_game_server_node_id_idx"
  on "public"."clip_render_jobs" ("game_server_node_id")
  where "game_server_node_id" is not null;

alter table "public"."clip_render_jobs"
  alter column "user_steam_id" drop not null;