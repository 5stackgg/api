insert into e_timeout_settings ("value", "description") values
    ('CoachAndPlayers', 'Coach And Players'),
    ('CoachAndCaptains', 'Coach And Captains'),
    ('Coach', 'Coach Only'),
    ('Admin', 'Admins Only')
on conflict(value) do update set "description" = EXCLUDED."description"
