insert into e_game_server_node_statuses ("value", "description") values
    ('Setup', 'Waiting to Setup'),
    ('Online', 'Online'),
    ('NotAcceptingNewMatches', 'Not Accepting New Matches'),
    ('Offline', 'Offline')
on conflict(value) do update set "description" = EXCLUDED."description"
