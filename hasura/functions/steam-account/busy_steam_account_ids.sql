create or replace function public.busy_steam_account_ids()
  returns setof uuid
  language sql
  stable
as $$
  select steam_account_id
    from match_streams
   where is_game_streamer = true
     and status is distinct from 'errored'
     and steam_account_id is not null
  union
  select steam_account_id
    from match_demo_sessions
   where status is distinct from 'errored'
     and steam_account_id is not null
  union
  select steam_account_id
    from clip_render_jobs
   where status in ('queued', 'rendering', 'uploading')
     and steam_account_id is not null
$$;
