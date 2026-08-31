-- The default_* columns are the shipped policy, not operator data: the settings
-- rows an operator edits are seeded from these once and never reset, so a
-- release is free to correct a default here without touching a live install.
insert into e_sanction_sources
    ("value", "description", default_enabled, default_threshold, default_window_days, default_durations, default_scope, writes_platform_ban)
values
    ('match_abandon', 'A player left or never connected to a match they were rostered for', true, 1, 7, '10,60,120,240,480,960,1920', 'matchmaking', false),
    ('vac_ban', 'Steam reports a VAC or game ban on the player''s account', true, 1, 0, '0', 'both', true),
    ('tournament_no_show', 'A team missed a required tournament check-in', true, 3, 30, '10080', 'tournaments', false)
on conflict(value) do update set
    "description" = EXCLUDED."description",
    default_enabled = EXCLUDED.default_enabled,
    default_threshold = EXCLUDED.default_threshold,
    default_window_days = EXCLUDED.default_window_days,
    default_durations = EXCLUDED.default_durations,
    default_scope = EXCLUDED.default_scope,
    writes_platform_ban = EXCLUDED.writes_platform_ban
