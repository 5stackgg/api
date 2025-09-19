create or replace function public.get_setting(
    searchKey text,
    default_value text
) returns text as $$
declare
    setting_value text;
begin
    select s.value into setting_value from settings s where s.name = searchKey;
    if setting_value is not null then
        return setting_value;
    else
        return default_value;
    end if;
end;
$$ language plpgsql;