insert into e_tournament_stage_types ("value", "description") values
    ('RoundRobin', 'Round Robin'),
    ('SingleElimination', 'Single Elimination'),
    ('DoubleElimination', 'Double Elimination')
on conflict(value) do update set "description" = EXCLUDED."description"
