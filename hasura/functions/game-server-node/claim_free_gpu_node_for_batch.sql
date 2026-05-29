-- Claims a free GPU node for a highlight/batch render.
--
-- Same process-busy rule as claim_free_gpu_node() (gpu_busy_node_ids()),
-- plus the render-only restriction (gpu_batch_blocked_node_ids()): skip
-- nodes running a live match when `pause_renders_during_active_match` is on.
--
-- Files apply alphabetically, so this runs before the helper functions it
-- calls exist on a fresh DB; defer body validation to creation-time so the
-- forward references don't fail.
set local check_function_bodies = off;
create or replace function public.claim_free_gpu_node_for_batch()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and status = 'Online'
     and id not in (select * from gpu_busy_node_ids())
     and id not in (select * from gpu_batch_blocked_node_ids())
   order by id
   for update skip locked
   limit 1
$$;
