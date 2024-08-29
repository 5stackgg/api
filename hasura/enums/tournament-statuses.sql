SET check_function_bodies = false;

insert into e_tournament_status ("value", "description") values
    ('Setup', 'Setup'),
    ('RegistrationOpen', 'Registration Open'),
    ('RegistrationClosed', 'Registration Closed'),
    ('Scheduled', 'Scheduled'),
    ('Live', 'Live'),
    ('Cancelled', 'Cancelled'),
    ('CancelledMinTeams', 'Cancelled because it did not meet minimum number of teams'),
    ('Finished', 'Finished')
on conflict(value) do update set "description" = EXCLUDED."description"
