-- Nodes a highlight/batch render must NOT claim because a live match is
-- running on them while `pause_renders_during_active_match` is enabled.
--
-- This is render-only: live streams and demo playback ignore it (a live
-- stream is expected to run alongside the match it's streaming). Only the
-- batch-render claim path (claim_free_gpu_node_for_batch) and the
-- pool-status view consult this set.
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
