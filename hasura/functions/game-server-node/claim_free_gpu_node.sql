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
