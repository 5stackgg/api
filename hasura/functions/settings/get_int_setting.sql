create or replace function public.get_int_setting(
    searchKey text,
    default_value int
) returns int as $$
declare
    raw_value text;
begin
    select s.value into raw_value from settings s where s.name = searchKey;
    if raw_value ~ '^-?[0-9]+$' then
        return raw_value::int;
    end if;
    return default_value;
end;
$$ language plpgsql stable;
