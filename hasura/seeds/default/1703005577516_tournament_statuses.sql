SET check_function_bodies = false;

insert into e_tournament_status ("value", "description") values
    ('Setup', 'Setup'),
    ('Live', 'Live'),
    ('Cancelled', 'Cancelled')
on conflict(value) do update set "description" = EXCLUDED."description"
