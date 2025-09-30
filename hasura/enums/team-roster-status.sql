insert into e_team_roster_statuses ("value", "description") values
    ('Starter', 'Starter'),
    ('Substitute', 'Substitute'),
    ('Benched', 'Benched')
on conflict(value) do update set "description" = EXCLUDED."description"
