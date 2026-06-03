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

-- Render-only: nodes running a live match while
-- `pause_renders_during_active_match` is on. Streams/demos ignore this.
create or replace function public.gpu_batch_blocked_node_ids()
  returns setof text
  language sql
  stable
as $$
  select s.game_server_node_id
    from matches m
    join servers s on s.id = m.server_id
   where m.status = 'Live'
     and s.game_server_node_id is not null
     and (
       select value from settings
        where name = 'pause_renders_during_active_match'
     ) = 'true'
$$;

create or replace function public.claim_free_gpu_node()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and gpu_streaming_enabled = true
     and status in ('Online', 'NotAcceptingNewMatches')
     and id not in (select * from gpu_busy_node_ids())
   order by id
   for update skip locked
   limit 1
$$;

create or replace function public.claim_free_gpu_node_for_demo()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and gpu_demos_enabled = true
     and status in ('Online', 'NotAcceptingNewMatches')
     and id not in (select * from gpu_busy_node_ids())
   order by id
   for update skip locked
   limit 1
$$;

create or replace function public.claim_free_gpu_node_for_batch()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and gpu_rendering_enabled = true
     and status in ('Online', 'NotAcceptingNewMatches')
     and id not in (select * from gpu_busy_node_ids())
     and id not in (select * from gpu_batch_blocked_node_ids())
   order by id
   for update skip locked
   limit 1
$$;
