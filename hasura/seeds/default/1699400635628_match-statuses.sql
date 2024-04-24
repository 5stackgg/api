SET check_function_bodies = false;

insert into e_match_status ("value", "description") values
    ('PickingPlayers', 'Picking Players'),
    ('Veto', 'Veto'),
    ('Live', 'Live'),
    ('Scheduled', 'Scheduled'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled')
on conflict(value) do update set "description" = EXCLUDED."description";




