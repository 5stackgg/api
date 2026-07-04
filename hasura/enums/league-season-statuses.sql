SET check_function_bodies = false;

insert into e_league_season_statuses ("value", "description") values
    ('Setup', 'Setup'),
    ('RegistrationOpen', 'Registration Open'),
    ('RegistrationClosed', 'Registration Closed'),
    ('Live', 'Live'),
    ('Playoffs', 'Playoffs'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled')
on conflict(value) do update set "description" = EXCLUDED."description"
