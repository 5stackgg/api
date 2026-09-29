insert into e_sanction_types ("value", "description") values
    ('ban', 'Player is not able to participate in any activity'),
    ('mute', 'Player cannot use voice chat in game'),
    ('gag', 'Player cannot use text chat in game'),
    ('silence', 'Player muted and gagged'),
    ('warning', 'Informational note on the player''s record; never enforced, never expires')
on conflict(value) do update set "description" = EXCLUDED."description"
