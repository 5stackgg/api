insert into e_ready_settings ("value", "description") values
    ('Players', 'All Players'),
    ('Captains', 'Captains Only'),
    ('Coach', 'Coach Only'),
    ('Admin', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description"
