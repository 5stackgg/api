insert into e_lobby_access ("value", "description") values
    ('Invite', 'Invite Only'),
    ('Open', 'Public'),
    ('Friends', 'Friends Only'),
    ('Private', 'Private')
on conflict(value) do update set "description" = EXCLUDED."description"
