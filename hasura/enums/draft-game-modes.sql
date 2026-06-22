insert into e_draft_game_mode ("value", "description") values
    ('Captains', 'Two Captains Draft'),
    ('Host', 'Host Assigns Teams'),
    ('Pug', 'Auto-Split Teams'),
    ('Teams', 'Pre-Made Teams')
on conflict(value) do update set "description" = EXCLUDED."description"
