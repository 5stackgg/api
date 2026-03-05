insert into e_match_mode ("value", "description") values
    ('admin', 'Match must be scheduled and started by an admin user'),
    ('auto', 'Match is automatically scheduled by the system')
on conflict(value) do update set "description" = EXCLUDED."description"
