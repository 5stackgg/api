insert into e_server_types ("value", "description") values
    ('Ranked', '5Stack Ranked Server'),
    ('Competitive', 'Valve Competitive'),
    ('Casual', 'Valve Casual'),
    ('Wingman', 'Valve Wingman'),
    ('Deathmatch', 'Valve Deathmatch'),
    ('ArmsRace', 'Valve Arms Race'),
    ('Retake', 'Valve Retake'),
    ('Custom', 'Custom')
on conflict(value) do update set "description" = EXCLUDED."description"
