create or replace view public.v_steam_account_pool_status as
select
  1 as id,
  (select count(*) from steam_accounts)::int as total_accounts,
  (select count(*) from steam_accounts
    where id not in (select * from busy_steam_account_ids()))::int as free_accounts,
  (select count(*) from busy_steam_account_ids())::int as busy_accounts;
