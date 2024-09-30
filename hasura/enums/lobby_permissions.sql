insert into e_lobby_access ("value", "description") values
    ('Invite', 'Invite Only'),
    ('Open', 'Open'),
    ('Private', 'Private')
on conflict(value) do update set "description" = EXCLUDED."description"
