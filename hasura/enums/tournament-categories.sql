SET check_function_bodies = false;

insert into e_tournament_categories ("value", "description") values
    ('LAN', 'LAN'),
    ('LocationEvent', 'Location Event'),
    ('OnlineEvent', 'Online Event'),
    ('League', 'League')
on conflict(value) do update set "description" = EXCLUDED."description"
