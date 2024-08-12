SET check_function_bodies = false;

insert into e_player_roles ("value", "description") values
    ('user', 'Basic User'),
    ('match_organizer', 'Ability Manage Matches and bypass restrictions'),
    ('tournament_organizer', 'Ability Create and Manage Tournaments'),
    ('admin', 'Administrator')
on conflict(value) do update set "description" = EXCLUDED."description"
