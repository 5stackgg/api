create or replace view public.v_gpu_pool_status as
with pool as (
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and status = 'Online'
),
busy as (
  select * from gpu_busy_node_ids()
),
batch_blocked as (
  -- nodes a batch render can't claim because a live match is using them and
  -- pause_renders_during_active_match is on (mirrors claim_free_gpu_node_for_batch)
  select s.game_server_node_id as id
    from matches m
    join servers s on s.id = m.server_id
   where m.status = 'Live'
     and s.game_server_node_id is not null
     and (
       select value from settings
        where name = 'pause_renders_during_active_match'
     ) = 'true'
)
select
  1 as id,
  (select count(*) from pool)::int as total_gpu_nodes,
  (select count(*) from pool
    where id not in (select * from busy))::int as free_gpu_nodes,
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
    where gpu = true) as registered_gpu_nodes,
  -- new columns must be appended at the end so `create or replace view`
  -- doesn't try to rename existing positional columns
  (select count(*) from pool
    where id not in (select * from busy)
      and id not in (select id from batch_blocked))::int as free_gpu_nodes_for_batch,
  -- true when an otherwise-idle GPU is held back from batch renders only
  -- because a live match is running on it
  exists (
    select 1 from pool
     where id not in (select * from busy)
       and id in (select id from batch_blocked)
  ) as renders_paused_for_active_match;
