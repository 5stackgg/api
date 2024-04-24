SET check_function_bodies = false;

insert into e_match_map_status ("value", "description") values
    ('Knife', 'Knife'),
    ('Live', 'Live'),
    ('Warmup', 'Warmup'),
    ('Paused', 'Paused'),
    ('Scheduled', 'Scheduled'),
    ('Overtime', 'Overtime'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled')
on conflict(value) do update set "description" = EXCLUDED."description"
