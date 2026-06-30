create or replace function public.claim_free_steam_account(p_node_id text default null)
  returns uuid
  language plpgsql
as $$
declare
  v_id uuid;
begin
  -- Prefer the account this node last logged in with so the
  -- per-account Steam cache stays warm.
  -- role = 'gpu' only: 'friends' accounts are reserved for the presence bot and
  -- must never be claimed for GPU work (a Steam account can't log in twice).
  if p_node_id is not null then
    select id
      into v_id
      from steam_accounts
     where last_node_id = p_node_id
       and role = 'gpu'
       and id not in (select * from busy_steam_account_ids())
     order by id
     for update skip locked
     limit 1;
  end if;

  if v_id is null then
    select id
      into v_id
      from steam_accounts
     where role = 'gpu'
       and id not in (select * from busy_steam_account_ids())
     order by id
     for update skip locked
     limit 1;
  end if;

  if v_id is not null and p_node_id is not null then
    update steam_accounts
       set last_node_id = p_node_id,
           updated_at = now()
     where id = v_id;
  end if;

  return v_id;
end;
$$;
