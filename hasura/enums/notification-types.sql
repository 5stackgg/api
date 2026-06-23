INSERT INTO e_notification_types ("value", "description") VALUES
    ('GameUpdate', 'GameUpdate'),
    ('MatchSupport', 'MatchSupport'),
    ('GameNodeStatus', 'GameNodeStatus'),
    ('NameChangeRequest', 'NameChangeRequest'),
    ('DedicatedServerStatus', 'DedicatedServerStatus'),
    ('DedicatedServerRconStatus', 'DedicatedServerRconStatus'),
    ('MatchStatusChange', 'Match Status Change Notification'),
    ('StorageScan', 'Storage Scan'),
    ('PlayerSanctioned', 'A player you recently played with received a sanction'),
    ('ScrimRequestReceived', 'A team requested to scrim yours'),
    ('ScrimRequestCountered', 'A team proposed a different scrim time'),
    ('ScrimRequestAccepted', 'Your scrim request was accepted'),
    ('ScrimRequestDeclined', 'Your scrim request was declined'),
    ('ScrimMatchScheduled', 'A scrim match has been scheduled'),
    ('ScrimAlertMatch', 'A team matching your scrim alert is available'),
    ('FormTeamSuggestion', 'You frequently play with these players')
ON CONFLICT("value") DO UPDATE
    SET "description" = EXCLUDED."description";
