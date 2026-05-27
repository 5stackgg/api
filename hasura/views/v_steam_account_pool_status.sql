create or replace view public.v_steam_account_pool_status as
with pool as (
  select id
    from steam_accounts
   where enabled = true
)
select
  1 as id,
  (select count(*) from pool)::int as total_accounts,
  (select count(*) from pool
    where id not in (select * from busy_steam_account_ids()))::int as free_accounts,
  (select count(*) from busy_steam_account_ids())::int as busy_accounts,
  (select count(*)::int from steam_accounts) as registered_accounts;
