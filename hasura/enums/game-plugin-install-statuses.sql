insert into e_game_plugin_install_statuses ("value", "description") values
    ('Pending', 'Queued for install on the node'),
    ('Installing', 'Downloading and unpacking into the node plugin store'),
    ('Installed', 'Present in the node plugin store and ready to be selected by a mode'),
    ('Failed', 'Install did not complete; see the recorded error'),
    ('Removing', 'Being deleted from the node plugin store')
on conflict(value) do update set "description" = EXCLUDED."description"
