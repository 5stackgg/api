INSERT INTO e_tournament_status ("value", "description") VALUES
    ('Paused', 'Paused')
ON CONFLICT(value) DO UPDATE SET "description" = EXCLUDED."description";
