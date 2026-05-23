insert into e_match_map_status ("value", "description") values
    ('Knife', 'Knife'),
    ('Live', 'Live'),
    ('Warmup', 'Warmup'),
    ('Paused', 'Paused'),
    ('Scheduled', 'Scheduled'),
    ('Overtime', 'Overtime'),
    ('WaitingForTV', 'WaitingForTV'),
    ('UploadingDemo', 'UploadingDemo'),
    ('Finished', 'Finished'),
    ('Canceled', 'Canceled'),
    ('Surrendered', 'Surrendered')
on conflict(value) do update set "description" = EXCLUDED."description"
