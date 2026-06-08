create or replace function public.busy_steam_account_ids()
  returns setof uuid
  language sql
  stable
as $$
  select steam_account_id from steam_account_claims
$$;
