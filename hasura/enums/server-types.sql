insert into e_server_types ("value", "description") values
    ('Ranked', 'Ranked'),
    ('Deathmatch', 'Deathmatch'),
    ('Retake', 'Retake'),
    ('Aim', 'Aim'),
    ('Custom', 'Custom')
on conflict(value) do update set "description" = EXCLUDED."description"
