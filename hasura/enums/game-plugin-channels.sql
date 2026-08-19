insert into e_game_plugin_channels ("value", "description") values
    ('Pinned', 'Stay on the installed version; a newer release only raises a notification'),
    ('Auto', 'Install new upstream releases automatically')
on conflict(value) do update set "description" = EXCLUDED."description"
