insert into e_game_plugin_kinds ("value", "description") values
    ('game', 'A CS2 server plugin that loads into the game server'),
    ('panel', 'A web app that mounts as a page inside the panel'),
    ('bundle', 'A panel plugin and a game plugin installed and wired together')
on conflict(value) do update set "description" = EXCLUDED."description"
