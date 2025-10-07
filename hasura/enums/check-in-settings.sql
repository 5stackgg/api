insert into e_check_in_settings ("value", "description") values
    ('Players', 'All Players'),
    ('Captains', 'Captains Only'),
    ('Admin', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description"
