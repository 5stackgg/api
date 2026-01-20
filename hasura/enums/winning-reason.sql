insert into e_winning_reasons ("value", "description") values
    ('TerroristsWin', 'Terrorists Win'),
    ('CTsWin', 'CTs Win'),
    ('BombExploded', 'Bomb Exploded'),
    ('TimeRanOut', 'Time Ran Out'),
    ('BombDefused', 'Bomb Defused'),
    ('Unknown', 'Unknown')
on conflict(value) do update set "description" = EXCLUDED."description"
