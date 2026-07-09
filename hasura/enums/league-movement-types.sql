SET check_function_bodies = false;

insert into e_league_movement_types ("value", "description") values
    ('Promote', 'Promoted to a higher division'),
    ('Relegate', 'Relegated to a lower division'),
    ('Stay', 'Stays in the same division'),
    ('Remove', 'Removed from the league'),
    ('DirectPromote', 'Promoted directly to a higher division'),
    ('RelegationUp', 'Plays a relegation playoff for a higher-division spot'),
    ('Hold', 'Holds its division'),
    ('RelegationDown', 'Plays a relegation playoff to keep its division'),
    ('DirectRelegate', 'Relegated directly to a lower division')
on conflict(value) do update set "description" = EXCLUDED."description"
