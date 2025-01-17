insert into e_friend_status ("value", "description") values
    ('Pending', 'Pending'),
    ('Accepted', 'Accepted')
on conflict(value) do update set "description" = EXCLUDED."description"
