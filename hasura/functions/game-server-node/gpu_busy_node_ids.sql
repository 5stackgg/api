create or replace function public.gpu_busy_node_ids()
  returns setof text
  language sql
  stable
as $$
  select game_server_node_id
    from match_streams
   where is_game_streamer = true
     and status is distinct from 'errored'
     and game_server_node_id is not null
  union
  select game_server_node_id
    from match_demo_sessions
   where status is distinct from 'errored'
     and game_server_node_id is not null
  union
  select game_server_node_id
    from clip_render_jobs
   where status in ('queued', 'rendering', 'uploading')
     and game_server_node_id is not null
$$;
