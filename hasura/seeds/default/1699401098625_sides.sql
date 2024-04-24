SET check_function_bodies = false;

insert into e_sides ("value", "description") values
    ('CT', 'Counter Terrorist'),
    ('TERRORIST', 'Terrorist'),
    ('Spectator', 'Spectator'),
    ('None', 'None')
on conflict(value) do update set "description" = EXCLUDED."description"
