insert into e_lobby_access ("value", "description") values
    ('Invite', 'Invite Only'),
    ('Open', 'Public'),
    ('Private', 'Private'),
    ('Friends', 'Friends Only')
on conflict(value) do update set "description" = EXCLUDED."description"
