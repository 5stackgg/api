create or replace function public.claim_free_steam_account(p_node_id text default null)
  returns uuid
  language plpgsql
as $$
declare
  v_id uuid;
begin
  -- Prefer the account this node last logged in with so the
  -- per-account Steam cache (game files, login keys) stays warm and
  -- subsequent pod boots skip the cold-cache download.
  if p_node_id is not null then
    select id
      into v_id
      from steam_accounts
     where enabled = true
       and last_node_id = p_node_id
       and id not in (select * from busy_steam_account_ids())
     order by id
     for update skip locked
     limit 1;
  end if;

  if v_id is null then
    select id
      into v_id
      from steam_accounts
     where enabled = true
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
