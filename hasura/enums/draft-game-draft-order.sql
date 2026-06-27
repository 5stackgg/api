insert into e_draft_game_draft_order ("value", "description") values
    ('Snake', 'Snake (1-2-2-2-1)'),
    ('Alternating', 'Alternating'),
    ('FrontLoaded', 'Front-Loaded (1-2-1-1)')
on conflict(value) do update set "description" = EXCLUDED."description"
