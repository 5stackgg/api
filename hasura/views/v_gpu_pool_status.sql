create or replace view public.v_gpu_pool_status as
with usable as (
  -- GPUs reachable for workloads: present, enabled, and either accepting
  -- matches (Online) or paused for new matches but still running
  -- (NotAcceptingNewMatches). GPU workloads (streaming/demo/render) don't
  -- require match acceptance, only that the node is enabled + reachable +
  -- the specific workload toggle is on.
  select id, gpu_streaming_enabled, gpu_demos_enabled, gpu_rendering_enabled
    from game_server_nodes
   where gpu = true
     and enabled = true
     and status in ('Online', 'NotAcceptingNewMatches')
),
busy as (
  -- taken by a process (live stream / demo / highlight render)
  select * from gpu_busy_node_ids()
),
batch_blocked as (
  -- render-only: live match on node + pause_renders_during_active_match
  select * from gpu_batch_blocked_node_ids()
)
select
  1 as id,
  (select count(*) from usable)::int as total_gpu_nodes,
  (select count(*) from usable
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
  (select count(*) from usable
    where gpu_rendering_enabled
      and id not in (select * from busy)
      and id not in (select * from batch_blocked))::int as free_gpu_nodes_for_batch,
  -- true when an otherwise-idle GPU is held back from batch renders only
  -- because a live match is running on it
  exists (
    select 1 from usable
     where gpu_rendering_enabled
       and id not in (select * from busy)
       and id in (select * from batch_blocked)
  ) as renders_paused_for_active_match,
  -- per-workload availability so the UI can respect each toggle independently
  (select count(*) from usable
    where gpu_streaming_enabled)::int as streaming_total_gpu_nodes,
  (select count(*) from usable
    where gpu_streaming_enabled
      and id not in (select * from busy))::int as streaming_free_gpu_nodes,
  (select count(*) from usable
    where gpu_demos_enabled)::int as demo_total_gpu_nodes,
  (select count(*) from usable
    where gpu_demos_enabled
      and id not in (select * from busy))::int as demo_free_gpu_nodes,
  (select count(*) from usable
    where gpu_rendering_enabled)::int as rendering_total_gpu_nodes;
