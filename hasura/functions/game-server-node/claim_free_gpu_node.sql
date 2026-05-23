create or replace function public.claim_free_gpu_node()
  returns text
  language sql
as $$
  with busy_nodes as (
    select game_server_node_id as id
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
  )
  select id
    from game_server_nodes
   where gpu = true
     and status = 'Online'
     and id not in (select id from busy_nodes)
   order by id
   for update skip locked
   limit 1
$$;
