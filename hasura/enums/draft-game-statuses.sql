insert into e_draft_game_status ("value", "description") values
    ('Open', 'Accepting Players'),
    ('Filled', 'Lobby Full'),
    ('SelectingCaptains', 'Selecting Captains'),
    ('Drafting', 'Drafting Players'),
    ('CreatingMatch', 'Creating Match'),
    ('Completed', 'Completed'),
    ('Canceled', 'Canceled')
on conflict(value) do update set "description" = EXCLUDED."description"
