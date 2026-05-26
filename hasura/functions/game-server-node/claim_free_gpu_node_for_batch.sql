create or replace function public.claim_free_gpu_node_for_batch()
  returns text
  language sql
as $$
  select id
    from game_server_nodes
   where gpu = true
     and status = 'Online'
     and id not in (select * from gpu_busy_node_ids())
     and id not in (
       select s.game_server_node_id
         from matches m
         join servers s on s.id = m.server_id
        where m.status = 'Live'
          and s.game_server_node_id is not null
          and (
            select value from settings
             where name = 'pause_renders_during_active_match'
          ) = 'true'
     )
   order by id
   for update skip locked
   limit 1
$$;
