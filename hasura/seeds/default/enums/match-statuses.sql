SET check_function_bodies = false;

insert into e_match_status ("value", "description") values
    ('PickingPlayers', 'Picking Players'),
    ('Scheduled', 'Scheduled'),
    ('WaitingForCheckIn', 'Waiting For Players to Check In'),
    ('Veto', 'Veto'),
    ('Live', 'Live'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled'),
    ('Forfeit', 'Forfeit'),
    ('Tie', 'Tie')
on conflict(value) do update set "description" = EXCLUDED."description";




