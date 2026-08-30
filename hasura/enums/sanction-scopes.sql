insert into e_sanction_scopes ("value", "description") values
    ('matchmaking', 'Bars the player from queueing and from draft lobbies'),
    ('tournaments', 'Bars the player from joining a tournament roster or free agent pool'),
    ('both', 'Bars the player from matchmaking and tournaments')
on conflict(value) do update set "description" = EXCLUDED."description"
