insert into e_tournament_registration_types ("value", "description") values
    ('teams', 'Only pre-formed teams may register'),
    ('free_agents', 'Only individual players may register; teams are drafted from the pool'),
    ('both', 'Pre-formed teams and individual free agents may both register')
on conflict(value) do update set "description" = EXCLUDED."description"
