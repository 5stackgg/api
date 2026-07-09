create or replace function game_version_supports_plugin(game_build_id integer, plugin_version text, plugin_runtime text default null) returns boolean as $$
declare
  plugin_version_record plugin_versions%rowtype;
  target_runtime text;
begin
  target_runtime := coalesce(plugin_runtime, active_plugin_runtime());

  if plugin_version is null then
    select * from plugin_versions
    where min_game_build_id is not null
    and plugin_versions.runtime = target_runtime
    order by published_at desc
    limit 1
    into plugin_version_record;
  else
    select * from plugin_versions
    where version = plugin_version
    and plugin_versions.runtime = target_runtime
    into plugin_version_record;

    if(plugin_version_record.min_game_build_id is null) then
       select * from plugin_versions
        where min_game_build_id is not null
        and plugin_versions.runtime = target_runtime
        AND published_at <= plugin_version_record.published_at
        order by published_at desc
        into plugin_version_record;
    end if;
  end if;

  IF plugin_version_record is null then
    return false;
  end if;

  return game_build_id >= plugin_version_record.min_game_build_id;
end;
$$ language plpgsql stable;
