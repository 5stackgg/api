SET check_function_bodies = false;

insert into e_player_roles ("value", "description") values
    ('User', 'Baisc User'),
    ('MatchOrganizer', 'Ability Manage Matches and bypass restrictions'),
    ('TournamentOrganizer', 'Ability Create and Manage Tournaments'),
    ('Admin', 'Administrator')
on conflict(value) do update set "description" = EXCLUDED."description"
