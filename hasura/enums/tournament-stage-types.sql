insert into e_tournament_stage_types ("value", "description") values
    ('SingleElimination', 'Single Elimination')
on conflict(value) do update set "description" = EXCLUDED."description"
