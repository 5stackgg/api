insert into e_objective_types ("value", "description") values
    ('Planted', 'Planted'),
    ('Defused', 'Defused'),
    ('Exploded', 'Exploded')
on conflict(value) do update set "description" = EXCLUDED."description"
