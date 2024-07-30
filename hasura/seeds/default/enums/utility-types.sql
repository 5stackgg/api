SET check_function_bodies = false;

insert into e_utility_types ("value", "description") values
    ('Decoy', 'Decoy'),
    ('HighExplosive', 'HighExplosive'),
    ('Flash', 'Flash'),
    ('Molotov', 'Molotov'),
    ('Smoke', 'Smoke')
on conflict(value) do update set "description" = EXCLUDED."description"
