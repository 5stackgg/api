insert into e_ready_settings ("value", "description") values
    ('Players', 'All Players'),
    ('Captains', 'Captains Only'),
    ('Coach', 'Coach Only'),
    ('Admins', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description"
