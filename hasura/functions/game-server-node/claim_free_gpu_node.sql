-- Claims a free GPU node for a live stream or demo playback.
--
-- A node is unavailable only when it's already taken by a process
-- (live stream / demo / highlight render) — see gpu_busy_node_ids().
-- The `pause_renders_during_active_match` setting is render-only and is
-- intentionally NOT applied here, so streams/demos can use a node even
-- while a match is live on it.
--
-- Files apply alphabetically, so this runs before gpu_busy_node_ids()
-- exists on a fresh DB; defer body validation so the forward ref is fine.
set local check_function_bodies = off;
create or replace function public.claim_free_gpu_node()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and enabled = true
     and status = 'Online'
     and id not in (select * from gpu_busy_node_ids())
   order by id
   for update skip locked
   limit 1
$$;
