insert into e_draft_game_captain_selection ("value", "description") values
    ('TopEloTwo', 'Top 2 by Rank'),
    ('HostAndNext', 'Host and Next Highest'),
    ('RandomTwo', 'Random Two')
on conflict(value) do update set "description" = EXCLUDED."description"
