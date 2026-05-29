create or replace view public.v_gpu_pool_status as
with pool as (
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and status = 'Online'
)
select
  1 as id,
  (select count(*) from pool)::int as total_gpu_nodes,
  (select count(*) from pool
    where id not in (select * from gpu_busy_node_ids()))::int as free_gpu_nodes,
  exists (
    select 1 from match_streams
     where is_game_streamer = true and status is distinct from 'errored'
  ) as live_in_progress,
  exists (
    select 1 from match_demo_sessions
     where status is distinct from 'errored'
  ) as demo_in_progress,
  exists (
    select 1 from clip_render_jobs
     where status in ('queued', 'rendering', 'uploading')
  ) as highlights_in_progress,
  (select count(*)::int
     from game_server_nodes
    where gpu = true) as registered_gpu_nodes;
