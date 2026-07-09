create or replace function active_plugin_runtime() returns text as $$
declare
  runtime text;
begin
  select value from settings
  where name = 'public.game_server_plugin_runtime'
  into runtime;

  if runtime is null or not exists (select 1 from e_plugin_runtimes where value = runtime) then
    return 'swiftlys2';
  end if;

  return runtime;
end;
$$ language plpgsql stable;
