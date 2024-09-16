INSERT INTO e_notification_types ("value", "description") VALUES
    ('MatchSupport', 'MatchSupport')
ON CONFLICT("value") DO UPDATE
    SET "description" = EXCLUDED."description";
