SET check_function_bodies = false;

insert into e_league_registration_statuses ("value", "description") values
    ('Pending', 'Pending review'),
    ('Approved', 'Approved'),
    ('Waitlisted', 'Waitlisted'),
    ('Declined', 'Declined'),
    ('Withdrawn', 'Withdrawn')
on conflict(value) do update set "description" = EXCLUDED."description"
