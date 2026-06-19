INSERT INTO e_notification_types ("value", "description") VALUES
    ('GameUpdate', 'GameUpdate'),
    ('MatchSupport', 'MatchSupport'),
    ('GameNodeStatus', 'GameNodeStatus'),
    ('NameChangeRequest', 'NameChangeRequest'),
    ('DedicatedServerStatus', 'DedicatedServerStatus'),
    ('DedicatedServerRconStatus', 'DedicatedServerRconStatus'),
    ('MatchStatusChange', 'Match Status Change Notification'),
    ('StorageScan', 'Storage Scan'),
    ('PlayerSanctioned', 'A player you recently played with received a sanction')
ON CONFLICT("value") DO UPDATE
    SET "description" = EXCLUDED."description";
