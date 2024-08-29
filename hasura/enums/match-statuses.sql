insert into e_match_status ("value", "description") values
    ('PickingPlayers', 'Picking Players'),
    ('Scheduled', 'Scheduled'),
    ('WaitingForCheckIn', 'Waiting for Players to Check In'),
    ('Veto', 'Veto'),
    ('WaitingForServer', 'Waiting for a Server to Become Available.'),
    ('Live', 'Live'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled'),
    ('Forfeit', 'Forfeit'),
    ('Tie', 'Tie')
on conflict(value) do update set "description" = EXCLUDED."description";




