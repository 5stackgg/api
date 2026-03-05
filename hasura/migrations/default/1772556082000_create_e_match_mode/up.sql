CREATE TABLE IF NOT EXISTS public.e_match_mode (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);
INSERT INTO e_match_mode ("value", "description") VALUES
    ('admin', 'Match must be scheduled and started by an admin user'),
    ('auto', 'Match is automatically scheduled by the system')
ON CONFLICT(value) DO UPDATE SET "description" = EXCLUDED."description";
