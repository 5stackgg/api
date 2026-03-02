INSERT INTO e_notification_types ("value", "description") VALUES
    ('GameUpdate', 'GameUpdate'),
    ('MatchSupport', 'MatchSupport'),
    ('GameNodeStatus', 'GameNodeStatus'),
    ('NameChangeRequest', 'NameChangeRequest'),
    ('DedicatedServerStatus', 'DedicatedServerStatus'),
    ('DedicatedServerRconStatus', 'DedicatedServerRconStatus'),
    ('MatchStatusChange', 'Match Status Change Notification')
ON CONFLICT("value") DO UPDATE
    SET "description" = EXCLUDED."description";
