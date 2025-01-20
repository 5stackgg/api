insert into e_lobby_player_status ("value", "description") values
    ('Invited', 'Invited'),
    ('Accepted', 'Accepted')
on conflict(value) do update set "description" = EXCLUDED."description"
